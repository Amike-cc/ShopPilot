/**
 * 浏览器会话管理器 - §4.3 BrowserSessionManager
 * 管理每个店铺的独立 Chromium session partition
 */

import { app, session, Session } from 'electron'
import { getDatabase } from '../db/database'
import { join, parse } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { recordDownload, updateDownloadState } from './download-manager'
import { getProxyCredentials } from '../services/credential-store'
import { writeAudit } from '../services/audit-logger'
import { clearStoreSessionSnapshot, trackStoreSession, untrackStoreSession, snapshotStoreSession } from '../services/session-persistence'
import { parseUaClientHints } from './fingerprint-injector'

/**
 * 改写 UA-CH 客户端提示请求头，使之与自定义 User-Agent 成对一致（§4.3）。
 * 仅作用于该 session，不安装到默认 session。
 */
function applyUserAgentClientHints(sess: Session, userAgent: string): void {
  const ch = parseUaClientHints(userAgent)
  if (!ch) return
  // 每个 session 只注册一次
  if ((sess as any).__chHooked) return
  ;(sess as any).__chHooked = true
  const brandsHeader = ch.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ')
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = { ...details.requestHeaders }
    const set = (name: string, value: string) => {
      // 大小写不敏感地覆盖
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) delete h[k]
      h[name] = value
    }
    set('sec-ch-ua', brandsHeader)
    set('sec-ch-ua-mobile', ch.mobile ? '?1' : '?0')
    set('sec-ch-ua-platform', `"${ch.platform}"`)
    callback({ requestHeaders: h })
  })
}

/** 店铺名转安全文件名片段 */
function sanitizeForFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}

/**
 * 活动的 session 实例缓存
 * Key: storeId, Value: Session
 */
const activeSessions = new Map<string, Session>()

/** 每店铺最近一次代理凭据注入事实（407 login → safeStorage 取出 → callback） */
const lastProxyAuth = new Map<string, { at: number; username: string; proxyId: string }>()
export function getProxyAuthInjection(storeId: string): { at: number; username: string; proxyId: string } | null {
  return lastProxyAuth.get(storeId) || null
}
/** §189 应用锁：销毁敏感内存引用（407 注入痕迹） */
export function clearProxyAuthTracking(): void {
  lastProxyAuth.clear()
}

/**
 * 生成店铺的 partition 名称 - §4.3
 * 格式：persist:store_<storeId>
 */
export function getStorePartition(storeId: string): string {
  return `persist:store_${storeId}`
}

/**
 * 获取或创建店铺的 session - §4.3
 */
export function getStoreSession(storeId: string): Session {
  // 检查缓存
  if (activeSessions.has(storeId)) {
    return activeSessions.get(storeId)!
  }
  
  // 创建新 session
  const partition = getStorePartition(storeId)
  const storeSession = session.fromPartition(partition, { cache: true })
  
  // 配置 session
  configureSession(storeSession, storeId)
  
  // 缓存
  activeSessions.set(storeId, storeSession)
  // 纳入定期会话快照（会话级 Cookie 不落盘，靠这份快照跨重启保住登录态）
  trackStoreSession(storeId)
  // Cookie 一变就快照（防抖 3s）：进程被强杀时也能留住最近的登录态，
  // 否则只能靠 60s 定时，最多丢一分钟内的登录动作
  try {
    let snapTimer: NodeJS.Timeout | null = null
    storeSession.cookies.on('changed', () => {
      if (snapTimer) clearTimeout(snapTimer)
      snapTimer = setTimeout(() => { void snapshotStoreSession(storeId).catch(() => {}) }, 3000)
    })
  } catch { /* 监听装不上不影响主流程（还有定时与退出前快照兜底） */ }
  
  return storeSession
}

/**
 * 配置 session 的基本设置
 */
function configureSession(sess: Session, storeId: string): void {
  // 设置 User-Agent - 从 browser_profiles 读取
  const db = getDatabase()
  const profile = db.prepare(`
    SELECT user_agent, language, ua_client_hints_json
    FROM browser_profiles
    WHERE store_id = ?
  `).get(storeId)
  
  if (profile?.user_agent) {
    // UA 与 accept-languages 成对设置；UA-CH 请求头随之改写（§4.3：禁止只改 UA 造成自相矛盾）
    const langs = profile.language ? `${profile.language},en-US` : undefined
    sess.setUserAgent(profile.user_agent, langs)
    applyUserAgentClientHints(sess, profile.user_agent)
  }
  
  // 设置语言（拼写检查语言需词典支持，非关键，失败忽略）
  if (profile?.language) {
    try {
      sess.setSpellCheckerLanguages([profile.language])
    } catch {
      // 例如 'zh-CN' 不在内置拼写词典中 → 忽略，不影响会话
    }
  }
  
  // 设置代理（如果有绑定）- §4.3 代理必须在首次导航前设置
  configureProxy(sess, storeId)

  // 代理 407 认证注入 - §4.3：proxyRules 不内嵌凭据，login 事件运行时注入
  // Electron 30 login details = { url, isMainFrame, firstAuthAttempt, responseHeaders }，无 isProxy；
  // 统一在 app 级单通道处理（session 级双注册会与 app 竞争，打断 Chromium 认证重放）
  ensureGlobalLoginHandler()
  
  // 配置权限处理 - §27 默认拒绝
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    // 地理位置、通知、摄像头、麦克风、剪贴板默认拒绝
    const allowedPermissions = ['clipboard-read', 'clipboard-write']
    callback(allowedPermissions.includes(permission))
  })
  
  // 配置下载处理 - §5.9 下载按店铺归档
  sess.on('will-download', (_event, item, webContents) => {
    try {
      const db = getDatabase()
      const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId)
      const storeName = sanitizeForFilename(store?.name || storeId)

      const downloadDir = join(app.getPath('userData'), 'stores', storeId, 'downloads')
      mkdirSync(downloadDir, { recursive: true })

      // 文件名加店铺前缀，重名追加序号 - §5.9
      const original = item.getFilename() || 'download'
      let prefixed = original.startsWith(storeName + '_') ? original : `${storeName}_${original}`
      let target = join(downloadDir, prefixed)
      let seq = 1
      while (existsSync(target)) {
        const parsed = parse(original)
        prefixed = `${storeName}_${parsed.name}(${seq})${parsed.ext}`
        target = join(downloadDir, prefixed)
        seq++
      }

      item.setSavePath(target)

      const pageUrl = (() => { try { return webContents.getURL() } catch { return undefined } })()
      const downloadId = recordDownload(storeId, prefixed, target, pageUrl)

      item.on('updated', (_e2, state) => {
        if (state === 'interrupted') updateDownloadState(downloadId, 'interrupted')
      })

      item.on('done', (_e2, state) => {
        if (state === 'completed') {
          updateDownloadState(downloadId, 'completed', item.getReceivedBytes())
        } else if (state === 'cancelled') {
          updateDownloadState(downloadId, 'cancelled')
        } else {
          updateDownloadState(downloadId, 'interrupted')
        }
      })
    } catch (err) {
      console.error('will-download error:', err)
    }
  })
}

/**
 * 配置代理 - §8.1, §4.3
 */
interface LoginDetails {
  url?: string
  isMainFrame?: boolean
  firstAuthAttempt?: boolean
  isProxy?: boolean
  responseHeaders?: Record<string, string[]>
}

/** 最近已处理的挑战 URL → 时间戳（session 级 + app 级双通道去重） */
const recentChallenges = new Map<string, number>()
function isDuplicateChallenge(url: string | undefined): boolean {
  if (!url) return false
  const now = Date.now()
  const last = recentChallenges.get(url)
  if (last && now - last < 1000) return true
  recentChallenges.set(url, now)
  if (recentChallenges.size > 200) {
    for (const [k, v] of recentChallenges) if (now - v > 5000) recentChallenges.delete(k)
  }
  return false
}

/** 代理挑战判定：显式 isProxy，或响应头含 proxy-authenticate（Electron 30 无 isProxy 字段） */
function looksLikeProxyChallenge(details: LoginDetails): boolean {
  if (details.isProxy) return true
  const rh = details.responseHeaders || {}
  return Object.keys(rh).some(k => k.toLowerCase() === 'proxy-authenticate')
}

/** 为一个店铺处理认证挑战：代理挑战 → 注入绑定代理凭据；否则取消 */
function handleLoginChallenge(storeId: string, details: LoginDetails, callback: (u?: string, p?: string) => void): void {
  console.log(`[login] store=${storeId} proxy=${looksLikeProxyChallenge(details)} first=${details.firstAuthAttempt} url=${details.url}`)
  if (!looksLikeProxyChallenge(details)) {
    callback() // 页面 HTTP Basic：取消，不弹窗不注入
    return
  }
  if (details.firstAuthAttempt === false) {
    callback() // 已注入过一次仍被拒 → 取消，避免凭据循环
    return
  }
  try {
    const db = getDatabase()
    const binding = db.prepare(
      "SELECT proxy_id FROM store_proxies WHERE store_id = ? AND mode != 'direct'"
    ).get(storeId) as any
    const cred = binding?.proxy_id ? getProxyCredentials(binding.proxy_id) : null
    console.log(`[login] binding=${JSON.stringify(binding)} credFound=${!!cred} user=${cred?.username}`)
    if (cred && cred.username) {
      lastProxyAuth.set(storeId, { at: Date.now(), username: cred.username, proxyId: binding.proxy_id })
      callback(cred.username, cred.password)
    } else {
      callback() // 无凭据 → 取消认证（请求将 407 失败，不弹系统框）
    }
  } catch (err) {
    console.error('proxy login injection failed:', err)
    callback()
  }
}

/**
 * app 级 login 兜底：session 级未挂到监听（或 webContents 反查失败）时按 partition / 实例匹配店铺。
 */
let loginHooked = false
function resolveStoreIdFromWebContents(wc: any): string | null {
  if (!wc) return null
  // 会话对象身份比对（Electron 同一 partition 返回同一 Session 单例，比 partition 字符串读取更可靠）
  const wcSession = wc.session
  if (wcSession) {
    for (const [id, s] of activeSessions) {
      if (s === wcSession) return id
    }
  }
  // 回退：读 partition 字符串
  const partition = wcSession?.partition || ''
  if (partition.startsWith('persist:store_')) return partition.slice('persist:store_'.length)
  return null
}

function ensureGlobalLoginHandler(): void {
  if (loginHooked) return
  loginHooked = true
  ;(app as any).on('login', (
    event: { preventDefault: () => void },
    webContents: any,
    details: LoginDetails,
    authInfo: { isProxy?: boolean } | undefined,
    callback: (username?: string, password?: string) => void
  ) => {
    event.preventDefault()
    const storeId = resolveStoreIdFromWebContents(webContents)
    const loginDetails: LoginDetails = { ...details, isProxy: authInfo?.isProxy === true || details?.isProxy === true }
    console.log(`[login:app] resolved store=${storeId} url=${details.url} proxyChallenge=${looksLikeProxyChallenge(loginDetails)}`)
    if (!storeId) { callback(); return }
    if (isDuplicateChallenge(details.url)) {
      console.log(`[login:app] dedup cancel url=${details.url}`)
      callback()
      return
    }
    handleLoginChallenge(storeId, loginDetails, callback)
  })
}

function configureProxy(sess: Session, storeId: string): void {
  const db = getDatabase()
  
  // 查询店铺绑定的代理
  const binding = db.prepare(`
    SELECT sp.mode, p.type, p.host, p.port, p.username_ref, p.password_ref
    FROM store_proxies sp
    LEFT JOIN proxies p ON sp.proxy_id = p.id
    WHERE sp.store_id = ?
  `).get(storeId)
  
  if (!binding || binding.mode === 'direct') {
    // 直连模式
    sess.setProxy({ mode: 'direct' })
    return
  }
  
  if (!binding.host || !binding.port) {
    // 绑定的代理已被删除（FK 置空）→ 回落直连，避免沿用过期的 setProxy 配置
    sess.setProxy({ mode: 'direct' })
    return
  }
  
  // 构建代理规则 - §4.3 不内嵌凭据（407 由 login 事件注入）
  const proxyRules = `${binding.type}://${binding.host}:${binding.port}`

  sess.setProxy({
    mode: 'fixed_servers',
    proxyRules
  }).catch(err => {
    console.error('setProxy failed:', err)
  })
}

/**
 * 重新应用代理配置（proxy:bind / proxy:update 后调用；session 已创建时）
 */
export function reconfigureProxy(storeId: string): void {
  const sess = activeSessions.get(storeId)
  if (sess) configureProxy(sess, storeId)
}

/**
 * 清理店铺 session - §8.4
 */
export async function clearStoreData(
  storeId: string,
  types: string[],
  origin?: string
): Promise<void> {
  const sess = getStoreSession(storeId)
  
  const options: any = {}
  
  if (origin) {
    options.origins = [origin]
  }
  
  // 映射清理类型
  const storages: string[] = []
  
  if (types.includes('cookies')) {
    storages.push('cookies')
  }
  if (types.includes('cache')) {
    storages.push('cachestorage')
  }
  if (types.includes('localStorage')) {
    storages.push('localstorage', 'indexeddb')
  }
  
  if (storages.length > 0) {
    options.storages = storages
    await sess.clearStorageData(options)
  }
  // 清了 Cookie 就必须同时丢掉会话快照，否则下次启动会把刚清掉的登录态又灌回来
  // （用户会以为"清数据没生效"）
  if (types.includes('cookies') && !origin) {
    try { clearStoreSessionSnapshot(storeId) } catch { /* 清理失败不阻塞 */ }
  }
  
  // 下载记录清理 - §5.9
  if (types.includes('downloads')) {
    const db = getDatabase()
    db.prepare('DELETE FROM downloads WHERE store_id = ?').run(storeId)
  }

  // §10.2 / §27：数据清理必须写审计
  writeAudit('browser.clearData', 'success', { storeId })
}

/**
 * 关闭店铺 session
 *
 * 关闭前**先快照会话级 Cookie**（异步、不阻塞）：微信小店的登录 Cookie 全是会话级，
 * Chromium 默认不落盘——不在这里存一份，关掉店铺窗口/退出应用后就得重新扫码。
 */
export function closeStoreSession(storeId: string): void {
  if (activeSessions.has(storeId)) {
    void snapshotStoreSession(storeId).catch(() => { /* 快照失败不阻塞关闭 */ })
    activeSessions.delete(storeId)
  }
  untrackStoreSession(storeId)
}

/**
 * 获取所有活动的 session
 */
export function getActiveSessions(): Map<string, Session> {
  return activeSessions
}
