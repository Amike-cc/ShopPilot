/**
 * 代理管理器 - §5.3 / §5.3.1 / §5.4 / §6.3
 * 凭据经 safeStorage 加密保管（credential-store），表内只存引用。
 */

import { randomBytes } from 'crypto'
import { connect, Socket } from 'net'
import { request as httpRequest } from 'http'
import { connect as tlsConnect, TLSSocket } from 'tls'
import { URL } from 'url'
import { getDatabase } from '../db/database'
import { saveProxyCredentials, deleteProxyCredentials, credentialRefs, getProxyCredentials } from '../services/credential-store'
import { reconfigureProxy } from '../browser/session-manager'
import { writeAudit } from '../services/audit-logger'

export type ProxyType = 'http' | 'https' | 'socks5'

export interface ProxyDraft {
  type: ProxyType
  host: string
  port: number
  label?: string
  tags?: string[]
  expiresAt?: number | null
}

export interface ProxyRecord {
  id: string
  type: string
  host: string
  port: number
  label: string | null
  tags: string[]
  expiresAt: number | null
  status: string
  lastIp: string | null
  lastLatencyMs: number | null
  lastCheckedAt: number | null
  hasCredential: boolean
  createdAt: number
  updatedAt: number
}

function generateProxyId(): string {
  return `proxy_${randomBytes(12).toString('hex')}`
}

function mapProxyRow(r: any): ProxyRecord {
  let tags: string[] = []
  try { tags = JSON.parse(r.tags_json || '[]') } catch { tags = [] }
  return {
    id: r.id, type: r.type, host: r.host, port: r.port,
    label: r.label ?? null, tags, expiresAt: r.expires_at ?? null,
    status: r.status, lastIp: r.last_ip ?? null,
    lastLatencyMs: r.last_latency_ms ?? null, lastCheckedAt: r.last_checked_at ?? null,
    hasCredential: !!(r.username_ref || r.password_ref),
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}

/** 校验代理草稿合法性 */
function assertValidDraft(draft: ProxyDraft): void {
  if (!draft || !draft.host) throw new Error('PROXY_INVALID')
  if (!['http', 'https', 'socks5'].includes(draft.type)) throw new Error('PROXY_INVALID')
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) throw new Error('PROXY_INVALID')
}

export function createProxy(draft: ProxyDraft, username?: string, password?: string): ProxyRecord {
  assertValidDraft(draft)
  const db = getDatabase()
  const id = generateProxyId()
  const refs = credentialRefs(id)
  const now = Date.now()

  const hasUser = username !== undefined && username !== null && username !== ''
  const hasPass = password !== undefined && password !== null && password !== ''
  if (hasUser || hasPass) {
    saveProxyCredentials(id, username ?? null, password ?? null)
  }

  db.prepare(`
    INSERT INTO proxies (id, type, host, port, username_ref, password_ref, label, tags_json,
      expires_at, status, last_ip, last_latency_ms, last_checked_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unchecked', NULL, NULL, NULL, ?, ?)
  `).run(
    id, draft.type, draft.host, draft.port,
    (hasUser || hasPass) ? refs.usernameRef : null,
    (hasUser || hasPass) ? refs.passwordRef : null,
    draft.label ?? null, JSON.stringify(draft.tags || []),
    draft.expiresAt ?? null, now, now
  )

  writeAudit('proxy.create', 'success')
  return getProxy(id)!
}

export function getProxy(proxyId: string): ProxyRecord | null {
  const r = getDatabase().prepare('SELECT * FROM proxies WHERE id = ?').get(proxyId)
  return r ? mapProxyRow(r) : null
}

export function listProxies(): ProxyRecord[] {
  return (getDatabase().prepare('SELECT * FROM proxies ORDER BY created_at DESC').all() as any[]).map(mapProxyRow)
}

export async function updateProxy(
  proxyId: string,
  patch: Partial<ProxyDraft> & { username?: string; password?: string }
): Promise<ProxyRecord> {
  const db = getDatabase()
  const existing = getProxy(proxyId)
  if (!existing) throw new Error('PROXY_NOT_FOUND')

  const merged: ProxyDraft = {
    type: (patch.type ?? existing.type) as ProxyType,
    host: patch.host ?? existing.host,
    port: patch.port ?? existing.port,
    label: patch.label !== undefined ? patch.label : existing.label ?? undefined,
    tags: patch.tags ?? existing.tags,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : existing.expiresAt
  }
  assertValidDraft(merged)

  const sets: string[] = ['type = ?', 'host = ?', 'port = ?', 'label = ?', 'tags_json = ?', 'expires_at = ?', 'updated_at = ?']
  const vals: any[] = [merged.type, merged.host, merged.port, merged.label ?? null, JSON.stringify(merged.tags || []), merged.expiresAt ?? null, Date.now()]

  if (patch.username !== undefined || patch.password !== undefined) {
    saveProxyCredentials(proxyId, patch.username ?? null, patch.password ?? null)
    const refs = credentialRefs(proxyId)
    sets.push('username_ref = ?', 'password_ref = ?')
    vals.push(refs.usernameRef, refs.passwordRef)
  }

  vals.push(proxyId)
  db.prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  // 活动店铺必须立即使用新地址/端口/凭据，不能等下一次打开浏览器。
  const boundStoreIds = (db.prepare('SELECT store_id FROM store_proxies WHERE proxy_id = ? AND mode = ?').all(proxyId, 'bound') as Array<{ store_id: string }>).map(row => row.store_id)
  await Promise.all(boundStoreIds.map(storeId => reconfigureProxy(storeId)))
  return getProxy(proxyId)!
}

export async function deleteProxy(proxyId: string): Promise<{ deleted: boolean; unboundStores: number }> {
  const db = getDatabase()
  // 外键会把绑定记录的 proxy_id 置空；保存受影响的店铺，删除后让活动 session 回落直连。
  const boundStoreIds = (db.prepare('SELECT store_id FROM store_proxies WHERE proxy_id = ?').all(proxyId) as Array<{ store_id: string }>).map(row => row.store_id)
  const info = db.prepare('DELETE FROM proxies WHERE id = ?').run(proxyId)
  if (info.changes > 0) {
    // **必须同步把绑定记录回落成 direct**：外键只把 proxy_id 置 NULL，`mode` 会留在 'bound'，
    // 于是 getStoreProxy 仍返回 {mode:'bound', proxyId:null} → 界面继续显示"当前：绑定代理"
    // （用户以为还有代理保护），而 session 实际已回落直连＝真实 IP 暴露，
    // 且 boundProxyRecords 要求 proxy_id IS NOT NULL → 该店从此不再被巡检。
    // 用户删代理的动机常常正是"这个代理有问题"，所以这条路径最容易踩（2026-09-28 审查确认）。
    const unbind = db.prepare("UPDATE store_proxies SET mode = 'direct', updated_at = ? WHERE store_id = ? AND mode = 'bound' AND proxy_id IS NULL")
    const now = Date.now()
    for (const storeId of boundStoreIds) {
      try { unbind.run(now, storeId) } catch { /* 单店失败不影响删除结果 */ }
    }
    deleteProxyCredentials(proxyId)
    await Promise.all(boundStoreIds.map(storeId => reconfigureProxy(storeId)))
    writeAudit('proxy.delete', 'success', { requestId: JSON.stringify({ proxyId, unboundStores: boundStoreIds.length }) })
  }
  return { deleted: info.changes > 0, unboundStores: info.changes > 0 ? boundStoreIds.length : 0 }
}

export interface ProxyCheckResult {
  ok: boolean
  latencyMs: number | null
  httpStatus: number | null
  exitIp: string | null
  geoCountry: string | null
  errorCode: string | null
}

const DEFAULT_PROXY_ECHO_URL = 'https://api.ipify.org?format=json'

function proxyAuthHeader(credentials?: { username?: string; password?: string }): string | undefined {
  if (!credentials?.username) return undefined
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password || ''}`).toString('base64')}`
}

function parseExitIp(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { ip?: unknown; address?: unknown }
    const candidate = String(parsed.ip ?? parsed.address ?? '').trim()
    return /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,45}$/i.test(candidate) ? candidate : null
  } catch {
    const match = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(body)
    return match?.[0] || null
  }
}

function requestOverConnectedSocket(socket: Socket | TLSSocket, target: URL, timeoutMs: number, connectedTls = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let requestSocket: Socket | TLSSocket = socket
    let settled = false
    const finish = (error?: Error, result?: { status: number; body: string }) => {
      if (settled) return
      settled = true
      try { requestSocket.destroy() } catch { /* already closed */ }
      if (error) reject(error); else resolve(result!)
    }
    const start = (readySocket: Socket | TLSSocket): void => {
      requestSocket = readySocket
      const req = httpRequest({
        method: 'GET', host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname || '/'}${target.search || ''}`,
        headers: { Host: target.host, Connection: 'close', Accept: 'application/json' },
        createConnection: () => readySocket,
        agent: false
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => finish(undefined, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 64 * 1024) }))
        res.on('error', error => finish(error))
      })
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('PROXY_TIMEOUT')) })
      req.on('error', error => finish(error))
      req.end()
    }
    if (connectedTls || target.protocol !== 'https:') { start(socket); return }
    const tlsSocket = tlsConnect({ socket, servername: target.hostname, rejectUnauthorized: true })
    tlsSocket.once('secureConnect', () => start(tlsSocket))
    tlsSocket.once('error', error => finish(error))
    tlsSocket.setTimeout(timeoutMs, () => finish(new Error('PROXY_TIMEOUT')))
  })
}

function connectHttpProxy(draft: ProxyDraft, target: URL, timeoutMs: number, credentials?: { username?: string; password?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const proxyAuth = proxyAuthHeader(credentials)
    if (draft.type === 'http' && target.protocol === 'http:') {
      const req = httpRequest({
        method: 'GET', host: draft.host, port: draft.port,
        path: target.toString(), headers: { Host: target.host, Connection: 'close', Accept: 'application/json', ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}) },
        agent: false
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 64 * 1024) }))
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('PROXY_TIMEOUT')))
      req.on('error', reject)
      req.end()
      return
    }
    const raw = draft.type === 'https'
      ? tlsConnect({ host: draft.host, port: draft.port, servername: draft.host, rejectUnauthorized: true })
      : connect({ host: draft.host, port: draft.port })
    raw.setTimeout(timeoutMs, () => raw.destroy(new Error('PROXY_TIMEOUT')))
    raw.once('error', reject)
    let tunnelStarted = false
    const startTunnel = (): void => {
      if (tunnelStarted) return
      tunnelStarted = true
      const headers = [`CONNECT ${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)} HTTP/1.1`, `Host: ${target.host}`, 'Connection: keep-alive']
      if (proxyAuth) headers.push(`Proxy-Authorization: ${proxyAuth}`)
      raw.write(`${headers.join('\r\n')}\r\n\r\n`)
    }
    if (draft.type === 'https') raw.once('secureConnect', startTunnel)
    else raw.once('connect', startTunnel)
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      raw.off('data', onData)
      const head = buffer.subarray(0, end).toString('latin1')
      const status = Number(/^HTTP\/\d\.\d\s+(\d+)/i.exec(head)?.[1] || 0)
      if (status !== 200) { raw.destroy(); reject(new Error(`PROXY_HTTP_${status || 'INVALID'}`)); return }
      // CONNECT 之后的响应头后如果已经带了正文，交给后续请求前丢弃；代理不会在此处合法返回正文。
      // HTTPS 代理的第一跳已是 TLS，但 CONNECT 后仍要为目标 HTTPS 建立第二层 TLS。
      requestOverConnectedSocket(raw, target, timeoutMs, false)
        .then(resolve, reject)
    }
    raw.on('data', onData)
  })
}

function connectSocks5Proxy(draft: ProxyDraft, target: URL, timeoutMs: number, credentials?: { username?: string; password?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const raw = connect({ host: draft.host, port: draft.port })
    raw.setTimeout(timeoutMs, () => raw.destroy(new Error('PROXY_TIMEOUT')))
    raw.once('error', reject)
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting'
    let buffer = Buffer.alloc(0)
    const consume = (length: number): Buffer | null => {
      if (buffer.length < length) return null
      const out = buffer.subarray(0, length); buffer = buffer.subarray(length); return out
    }
    raw.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        if (stage === 'greeting') {
          const head = consume(2); if (!head) return
          if (head[0] !== 5) throw new Error('PROXY_SOCKS5_INVALID')
          if (head[1] === 2 && credentials?.username) {
            const user = Buffer.from(credentials.username); const pass = Buffer.from(credentials.password || '')
            raw.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass])); stage = 'auth'; return
          }
          if (head[1] !== 0) throw new Error('PROXY_AUTH_REQUIRED')
          stage = 'connect'
          const host = Buffer.from(target.hostname)
          const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
          raw.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([port >> 8, port & 255])]))
          return
        }
        if (stage === 'auth') {
          const auth = consume(2); if (!auth) return
          if (auth[1] !== 0) throw new Error('PROXY_AUTH_FAILED')
          stage = 'connect'
          const host = Buffer.from(target.hostname)
          const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
          raw.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([port >> 8, port & 255])]))
          return
        }
        const head = consume(4); if (!head) return
        if (head[0] !== 5 || head[1] !== 0) throw new Error('PROXY_SOCKS5_CONNECT_FAILED')
        const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : buffer[0]
        const skip = head[3] === 3 ? 1 + addressLength + 2 : addressLength + 2
        if (!consume(skip)) return
        raw.removeAllListeners('data')
        requestOverConnectedSocket(raw, target, timeoutMs).then(resolve, reject)
      } catch (error) { raw.destroy(); reject(error) }
    })
    raw.once('connect', () => raw.write(Buffer.from([5, credentials?.username ? 2 : 1, 0, ...(credentials?.username ? [2] : [])])))
  })
}

/** 代理体检：真实协议握手 + HTTP 状态 + 出口 IP。只做连接测试不会再被标记为健康。 */
export async function testProxyAsync(
  draft: ProxyDraft,
  opts: { proxyId?: string; timeoutMs?: number } = {}
): Promise<ProxyCheckResult> {
  assertValidDraft(draft)
  const timeoutMs = opts.timeoutMs ?? 4000
  const start = Date.now()
  const credentials = opts.proxyId ? getProxyCredentials(opts.proxyId) : undefined
  const echoUrl = new URL(process.env.SHOPILOT_PROXY_ECHO_URL || DEFAULT_PROXY_ECHO_URL)
  let result: ProxyCheckResult
  try {
    const response = draft.type === 'socks5'
      ? await connectSocks5Proxy(draft, echoUrl, timeoutMs, credentials || undefined)
      : await connectHttpProxy(draft, echoUrl, timeoutMs, credentials || undefined)
    const exitIp = parseExitIp(response.body)
    const ok = response.status >= 200 && response.status < 400 && !!exitIp
    result = { ok, latencyMs: Date.now() - start, httpStatus: response.status || null, exitIp, geoCountry: null, errorCode: ok ? null : (!exitIp ? 'PROXY_EXIT_IP_UNAVAILABLE' : 'PROXY_HTTP_STATUS') }
  } catch (error) {
    const msg = String((error as Error)?.message || error)
    result = { ok: false, latencyMs: null, httpStatus: null, exitIp: null, geoCountry: null, errorCode: msg === 'PROXY_TIMEOUT' ? 'PROXY_TIMEOUT' : msg.startsWith('PROXY_') ? msg.slice(0, 64) : 'PROXY_UNREACHABLE' }
  }

  if (opts.proxyId) {
    recordCheck(opts.proxyId, result)
  }
  return result
}

function recordCheck(proxyId: string, result: ProxyCheckResult): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO proxy_checks (id, proxy_id, ok, http_status, latency_ms, exit_ip, geo_country, error_code, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`pc_${randomBytes(10).toString('hex')}`, proxyId, result.ok ? 1 : 0, result.httpStatus, result.latencyMs, result.exitIp, result.geoCountry, result.errorCode, now)

  db.prepare(`
    UPDATE proxies SET status = ?, last_ip = ?, last_latency_ms = ?, last_checked_at = ?, updated_at = ? WHERE id = ?
  `).run(result.ok ? 'ok' : 'error', result.exitIp, result.latencyMs, now, now, proxyId)

  // 每代理保留最近 100 条，滚动清理 - §5.3.1
  db.prepare(`
    DELETE FROM proxy_checks WHERE proxy_id = ? AND id NOT IN (
      SELECT id FROM proxy_checks WHERE proxy_id = ? ORDER BY checked_at DESC LIMIT 100
    )
  `).run(proxyId, proxyId)
}

/**
 * 绑定/解绑代理到店铺，并即时对活动 session 生效 - §5.4 / §6.3
 * mode：proxyId 非空 = 'bound'，否则 'direct'
 */
export async function bindProxy(storeId: string, proxyId: string | null): Promise<void> {
  const db = getDatabase()
  const mode = proxyId ? 'bound' : 'direct'
  db.prepare(`
    INSERT INTO store_proxies (store_id, proxy_id, mode, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      proxy_id = excluded.proxy_id, mode = excluded.mode, updated_at = excluded.updated_at
  `).run(storeId, proxyId, mode, Date.now())

  // 若该店铺浏览器已打开，重新应用代理配置（首次导航前设置）
  await reconfigureProxy(storeId)
  writeAudit('proxy.bind', 'success', { storeId })
}

export function getStoreProxy(storeId: string): { mode: string; proxyId: string | null } | null {
  const r = getDatabase().prepare('SELECT mode, proxy_id FROM store_proxies WHERE store_id = ?').get(storeId) as any
  return r ? { mode: r.mode, proxyId: r.proxy_id ?? null } : null
}

export function proxyHistory(proxyId: string, limit = 20): Array<Record<string, unknown>> {
  const db = getDatabase()
  return (db.prepare(
    'SELECT * FROM proxy_checks WHERE proxy_id = ? ORDER BY checked_at DESC LIMIT ?'
  ).all(proxyId, Math.min(Math.max(limit, 1), 100)) as any[]).map((r: any) => ({
    id: r.id, ok: r.ok === 1, httpStatus: r.http_status, latencyMs: r.latency_ms,
    exitIp: r.exit_ip, geoCountry: r.geo_country, errorCode: r.error_code, checkedAt: r.checked_at
  }))
}

/** 被店铺绑定的代理清单（巡检对象） */
export function boundProxyRecords(): ProxyRecord[] {
  const db = getDatabase()
  return (db.prepare(`
    SELECT p.* FROM proxies p WHERE p.id IN (
      SELECT DISTINCT proxy_id FROM store_proxies WHERE mode = 'bound' AND proxy_id IS NOT NULL
    ) ORDER BY p.updated_at DESC
  `).all() as any[]).map(mapProxyRow)
}

/**
 * 健康巡检 - §8.1/§13：复检并广播状态事件，**绝不自动切换/静默降级**。
 * emit 注入避免对 window-manager 的反向依赖。
 */
export async function sweepBoundProxies(
  emit: (payload: { proxyId: string; status: string; latencyMs: number | null; httpStatus: number | null; exitIp: string | null; errorCode: string | null }) => void
): Promise<number> {
  let n = 0
  for (const rec of boundProxyRecords()) {
    const before = rec.status
    const r = await testProxyAsync(
      { type: rec.type as ProxyType, host: rec.host, port: rec.port },
      { proxyId: rec.id, timeoutMs: 4000 }
    )
    n++
    const after = r.ok ? 'ok' : 'error'
    if (after !== before || !r.ok) emit({ proxyId: rec.id, status: after, latencyMs: r.latencyMs, httpStatus: r.httpStatus, exitIp: r.exitIp, errorCode: r.errorCode })
  }
  return n
}

/** 单代理复检（开店铺浏览器时的新鲜度检查） */
export async function revalidateProxy(proxyId: string): Promise<{ status: string; latencyMs: number | null; httpStatus: number | null; exitIp: string | null; errorCode: string | null } | null> {
  const rec = getProxy(proxyId)
  if (!rec) return null
  const r = await testProxyAsync(
    { type: rec.type as ProxyType, host: rec.host, port: rec.port },
    { proxyId, timeoutMs: 4000 }
  )
  return { status: r.ok ? 'ok' : 'error', latencyMs: r.latencyMs, httpStatus: r.httpStatus, exitIp: r.exitIp, errorCode: r.errorCode }
}
