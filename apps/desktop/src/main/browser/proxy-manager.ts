/**
 * 代理管理器 - §5.3 / §5.3.1 / §5.4 / §6.3
 * 凭据经 safeStorage 加密保管（credential-store），表内只存引用。
 */

import { randomBytes } from 'crypto'
import { connect, Socket } from 'net'
import { getDatabase } from '../db/database'
import { saveProxyCredentials, deleteProxyCredentials, credentialRefs } from '../services/credential-store'
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

export function updateProxy(
  proxyId: string,
  patch: Partial<ProxyDraft> & { username?: string; password?: string }
): ProxyRecord {
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
  return getProxy(proxyId)!
}

export function deleteProxy(proxyId: string): boolean {
  const db = getDatabase()
  const info = db.prepare('DELETE FROM proxies WHERE id = ?').run(proxyId)
  if (info.changes > 0) {
    deleteProxyCredentials(proxyId)
    writeAudit('proxy.delete', 'success')
  }
  return info.changes > 0
}

/**
 * 连接体检（异步）：TCP 可达性 + 延迟。写入 proxy_checks（若已知 proxyId）。
 * 退出 IP 检测需外部回显服务（网络相关），此处如实留空。
 */
export async function testProxyAsync(
  draft: ProxyDraft,
  opts: { proxyId?: string; timeoutMs?: number } = {}
): Promise<{ ok: boolean; latencyMs: number | null; errorCode: string | null }> {
  const timeoutMs = opts.timeoutMs ?? 4000
  const start = Date.now()
  const result = await new Promise<{ ok: boolean; latencyMs: number | null; errorCode: string | null }>((resolve) => {
    let settled = false
    const sock: Socket = connect({ host: draft.host, port: draft.port })
    const finish = (ok: boolean, errorCode: string | null) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve({ ok, latencyMs: ok ? Date.now() - start : null, errorCode })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true, null))
    sock.once('timeout', () => finish(false, 'PROXY_UNREACHABLE'))
    sock.once('error', () => finish(false, 'PROXY_UNREACHABLE'))
  })

  if (opts.proxyId) {
    recordCheck(opts.proxyId, result)
  }
  return result
}

function recordCheck(proxyId: string, result: { ok: boolean; latencyMs: number | null; errorCode: string | null }): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO proxy_checks (id, proxy_id, ok, http_status, latency_ms, exit_ip, geo_country, error_code, checked_at)
    VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
  `).run(`pc_${randomBytes(10).toString('hex')}`, proxyId, result.ok ? 1 : 0, result.latencyMs, result.errorCode, now)

  db.prepare(`
    UPDATE proxies SET status = ?, last_latency_ms = ?, last_checked_at = ?, updated_at = ? WHERE id = ?
  `).run(result.ok ? 'ok' : 'error', result.latencyMs, now, now, proxyId)

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
export function bindProxy(storeId: string, proxyId: string | null): void {
  const db = getDatabase()
  const mode = proxyId ? 'bound' : 'direct'
  db.prepare(`
    INSERT INTO store_proxies (store_id, proxy_id, mode, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      proxy_id = excluded.proxy_id, mode = excluded.mode, updated_at = excluded.updated_at
  `).run(storeId, proxyId, mode, Date.now())

  // 若该店铺浏览器已打开，重新应用代理配置（首次导航前设置）
  reconfigureProxy(storeId)
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
  emit: (payload: { proxyId: string; status: string; latencyMs: number | null; errorCode: string | null }) => void
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
    if (after !== before || !r.ok) emit({ proxyId: rec.id, status: after, latencyMs: r.latencyMs, errorCode: r.errorCode })
  }
  return n
}

/** 单代理复检（开店铺浏览器时的新鲜度检查） */
export async function revalidateProxy(proxyId: string): Promise<{ status: string; latencyMs: number | null; errorCode: string | null } | null> {
  const rec = getProxy(proxyId)
  if (!rec) return null
  const r = await testProxyAsync(
    { type: rec.type as ProxyType, host: rec.host, port: rec.port },
    { proxyId, timeoutMs: 4000 }
  )
  return { status: r.ok ? 'ok' : 'error', latencyMs: r.latencyMs, errorCode: r.errorCode }
}
