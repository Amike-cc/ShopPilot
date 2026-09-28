/**
 * 浏览器会话管理器 - §4.3 BrowserSessionManager
 * 管理每个店铺的独立 Chromium session partition
 */

import { app, session, Session } from 'electron'
import { getDatabase } from '../db/database'
import { join, parse } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { recordDownload, updateDownloadState, emitDownloadCreated, emitDownloadProgress } from './download-manager'
import { getProxyCredentials } from '../services/credential-store'
import { writeAudit } from '../services/audit-logger'
import { logMain } from '../services/logger'
import { trackStoreSession, untrackStoreSession, snapshotStoreSession } from '../services/session-persistence'
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

/** 唯一放行的权限：剪贴板**写入**（页面的"复制"按钮要用）。读取一律拒绝——
 *  剪贴板里可能是用户刚复制的密码/验证码/订单信息，页面没有理由能读到它。
 *  注意 Electron 30 的枚举里写入叫 clipboard-sanitized-write（没有 clipboard-write），
 *  两个名字都列上，避免再踩"写死的名字永远匹配不上"。 */
const ALLOWED_PERMISSIONS = ['clipboard-sanitized-write', 'clipboard-write']

/**
 * 权限收口（§27 默认拒绝）。**request 与 check 两条路径都要实现**。
 *
 * 为什么必须成对：Electron 文档明确写着"must also implement setPermissionCheckHandler to get
 * complete permission handling. Most web APIs do a permission check and then make a permission
 * request if the check is denied"——只实现 request 时，走 check 路径的 API（权限查询、
 * 部分媒体/全屏/存储访问判定）不受"默认拒绝"约束。2026-09-28 审查确认：全仓只有
 * request handler，主窗口与密码窗所在的默认 session 更是一个都没有。
 *
 * 设备权限（HID/串口/USB）与屏幕共享本项目没有使用场景，直接拒绝。
 * 屏幕共享**故意不设 handler**：Electron 未设置 handler 时不授予（安全默认），
 * 而设一个写错的 handler 反而可能放开——宁可留空。
 *
 * 整体 try/catch：这些 API 若在某个 Electron 版本上缺失/改名，绝不能让店铺 session 建立失败。
 */
function applyPermissionHandlers(sess: Session, label: string): void {
  try {
    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.includes(String(permission))
      let origin = 'unknown'
      try { origin = new URL(webContents.getURL()).origin } catch { /* about:blank 时按 unknown 记 */ }
      logMain('info', `[permission] ${allowed ? 'allow' : 'deny'} permission=${permission} origin=${origin} ${label}`)
      callback(allowed)
    })
  } catch (e: any) {
    logMain('warn', `[permission] 安装 request handler 失败 ${label}: ${String(e?.message || e)}`)
  }
  try {
    sess.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.includes(String(permission)))
  } catch (e: any) {
    logMain('warn', `[permission] 安装 check handler 失败 ${label}: ${String(e?.message || e)}`)
  }
  try {
    sess.setDevicePermissionHandler(() => false)
  } catch (e: any) {
    logMain('warn', `[permission] 安装 device handler 失败 ${label}: ${String(e?.message || e)}`)
  }
}

/**
 * 给**默认 session**（主窗口 + 密码/确认对话框）补上同一套权限收口。
 * 在 app ready、创建任何窗口之前调用（index.ts 的 initialize）。
 */
export function applyDefaultSessionPermissions(): void {
  try {
    applyPermissionHandlers(session.defaultSession, 'default-session')
  } catch (e: any) {
    logMain('warn', `[permission] 默认 session 权限收口失败：${String(e?.message || e)}`)
  }
}

/**
 * 下载文件名净化：平台给的名字（Content-Disposition）不可信。
 *   · 只取 basename（挡 `..\..\x` 这类目录穿越）；
 *   · 去掉路径分隔符与 Windows 非法字符 `\ / : * ? " < > |`、控制字符；
 *   · 挡 Windows 保留设备名（CON/NUL/COM1…，含带扩展名的形式）；
 *   · 去掉结尾的点与空格（Windows 上会被静默截断，导致库里记的路径与真实文件不一致）。
 */
export function safeDownloadName(raw: unknown): string {
  const base = String(raw || '').split(/[\\/]/).pop() || ''
  // 按码点过滤：控制字符（<0x20、0x7f）与 Windows 非法字符 `<>:"|?*`。
  // 用码点判断而不是控制字符正则，避免 `no-control-regex`
  const stripped = Array.from(base)
    .filter(ch => {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) return false
      return !'<>:"|?*'.includes(ch)
    })
    .join('')
  let name = stripped.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  const stem = name.replace(/\.[^.]*$/, '').toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`
  if (!name) name = 'download'
  return name.slice(0, 120)
}

/**
 * 活动的 session 实例缓存
 * Key: storeId, Value: Session
 */
const activeSessions = new Map<string, Session>()

/** 每个店铺 session 的初始配置完成状态；首次导航必须等代理配置完成。 */
const sessionReady = new Map<string, Promise<void>>()

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
  
  // 配置 session。代理配置是异步的，保存 Promise 供首次导航/重配置等待。
  const ready = configureSession(storeSession, storeId)
  sessionReady.set(storeId, ready)
  // 没有需要等待的调用方时也要标记 rejection 已被消费，避免 Node 未处理拒绝。
  void ready.catch(() => {})
  
  // 缓存
  activeSessions.set(storeId, storeSession)
  // 纳入定期会话快照（会话级 Cookie 不落盘，靠这份快照跨重启保住登录态）
  trackStoreSession(storeId)
  // Cookie 一变就快照（防抖 3s）：进程被强杀时也能留住最近的登录态，
  // 否则只能靠 60s 定时，最多丢一分钟内的登录动作。
  //
  // **每个 session 只装一次**：`session.fromPartition` 是 Electron 的单例，但
  // `closeStoreSession` 只删 Map 条目、销毁不了这个 Session 对象——于是"删店→恢复→再开店"
  // 每绕一圈都会在**同一个** Session 上再 `on('changed')` 一次。N 份监听 = 一次 Cookie
  // 变更触发 N 次同步加密+写盘（2026-09-28 审查确认的写放大/监听器泄漏）。
  try {
    if (!(storeSession as any).__cookieSnapHooked) {
      ;(storeSession as any).__cookieSnapHooked = true
      let snapTimer: NodeJS.Timeout | null = null
      storeSession.cookies.on('changed', () => {
        if (snapTimer) clearTimeout(snapTimer)
        snapTimer = setTimeout(() => {
          // 防抖期间店铺可能已被彻底删除/会话已关闭：绝不能再快照，否则 getStoreSession
          // 会为已删店铺重建分区（重新登记进 activeSessions/trackedStores），已清掉的
          // 登录凭据文件可能被写回磁盘。比较 session 实例身份同时挡住"已关闭"与"已重建"。
          if (activeSessions.get(storeId) !== storeSession) return
          void snapshotStoreSession(storeId).catch(() => {})
        }, 3000)
      })
    }
  } catch { /* 监听装不上不影响主流程（还有定时与退出前快照兜底） */ }
  
  return storeSession
}

/** 等待店铺 session 的初始配置（尤其是代理）完成。 */
export async function waitForStoreSessionReady(storeId: string): Promise<void> {
  // ShopSessionManager 可能已经先取得了同一店铺的 Session；复用现有配置 Promise，
  // 避免 WebContentsView 创建时重复注册 webRequest / download 监听器。
  if (!activeSessions.has(storeId) || !sessionReady.has(storeId)) getStoreSession(storeId)
  await sessionReady.get(storeId)
}

/**
 * 配置 session 的基本设置
 */
function configureSession(sess: Session, storeId: string): Promise<void> {
  // 设置 User-Agent - 从 browser_profiles 读取
  const db = getDatabase()
  const profile = db.prepare(`
    SELECT user_agent, language, ua_client_hints_json
    FROM browser_profiles
    WHERE store_id = ?
  `).get(storeId) as { user_agent?: string; language?: string; ua_client_hints_json?: string } | undefined
  
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
  const proxyReady = configureProxy(sess, storeId)

  // 代理 407 认证注入 - §4.3：proxyRules 不内嵌凭据，login 事件运行时注入
  // Electron 30 login details = { url, isMainFrame, firstAuthAttempt, responseHeaders }，无 isProxy；
  // 统一在 app 级单通道处理（session 级双注册会与 app 竞争，打断 Chromium 认证重放）
  ensureGlobalLoginHandler()
  
  // 配置权限处理 - §27 默认拒绝（request + check 两条路径都要覆盖，见函数内注释）
  applyPermissionHandlers(sess, `store=${storeId}`)
  // 配置下载处理 - §5.9 下载按店铺归档
  // 同 Cookie 监听：Session 是单例，重复进入这里会在同一个对象上叠加监听 →
  // 一次下载写 N 条 downloads 记录 + N 次 mkdirSync（2026-09-28 审查确认）。
  if (!(sess as any).__downloadHooked) {
    ;(sess as any).__downloadHooked = true
    sess.on('will-download', (_event, item, webContents) => {
    try {
      const db = getDatabase()
      const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId) as { name: string } | undefined
      const storeName = sanitizeForFilename(store?.name || storeId)

      const downloadDir = join(app.getPath('userData'), 'stores', storeId, 'downloads')
      mkdirSync(downloadDir, { recursive: true })

      // 文件名加店铺前缀，重名追加序号 - §5.9
      //
      // 先做 basename + 字符清洗：`getFilename()` 是平台（Content-Disposition）给的名字，
      // 上游没有"已清洗"的承诺，带 `..\` 或非法字符就会写出下载目录之外或落盘失败。
      // 同时挡掉 Windows 保留名（CON/NUL/COM1…）与尾随点/空格。
      const original = safeDownloadName(item.getFilename())
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
      // 新下载要让界面立刻看到（此前 BROWSER_DOWNLOAD_CREATED 两侧皆空＝死事件）
      emitDownloadCreated({ id: downloadId, storeId, fileName: prefixed, filePath: target })

      item.on('updated', (_e2, state) => {
        if (state !== 'progressing') updateDownloadState(downloadId, 'interrupted')
        emitDownloadProgress({
          id: downloadId, storeId,
          state: state === 'progressing' ? 'progressing' : 'interrupted',
          receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes()
        })
      })

      item.on('done', (_e2, state) => {
        const finalState = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
        if (finalState === 'completed') {
          updateDownloadState(downloadId, 'completed', item.getReceivedBytes())
        } else {
          updateDownloadState(downloadId, finalState)
        }
        // 完成/中断/取消都要推：面板据此更新，失败也才有用户可见的终点
        emitDownloadProgress({
          id: downloadId, storeId, state: finalState,
          receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes()
        })
        if (finalState !== 'completed') {
          logMain('warn', `[download] ${finalState} store=${storeId} file=${prefixed}`)
        }
      })
    } catch (err) {
      // 目录创建/落盘准备失败：**不要**让下载悄悄落到 Chromium 默认目录而应用无记录。
      // 取消它并留日志，用户至少能在下载面板看到一条 cancelled。
      logMain('error', `[download] will-download 处理失败 store=${storeId}: ${String(err)}`)
      try { item.cancel() } catch { /* 已结束 */ }
    }
    })
  }

  return proxyReady
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

/**
 * 最近已处理的挑战 → 时间戳（session 级 + app 级双通道去重）。
 *
 * 键必须带 storeId：仅按 URL 去重时，**两家店绑同一代理、同时导航同一 URL**
 * （多店并发自动化正是主场景）会让后到的那家被判定"重复"而取消认证 → 该请求 407 失败。
 * 症状是"某店页面偶发打不开、重试就好"，极难排查（2026-09-28 审查确认）。
 */
const recentChallenges = new Map<string, number>()
function isDuplicateChallenge(storeId: string, url: string | undefined): boolean {
  if (!url) return false
  const key = `${storeId}\u0000${url}`
  const now = Date.now()
  const last = recentChallenges.get(key)
  if (last && now - last < 1000) return true
  recentChallenges.set(key, now)
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
  // 走统一日志（logMain）：URL 查询参数值与 user= 的值在写入前被值级脱敏，不再直接写标准输出
  logMain('info', `[login] proxy challenge store=${storeId} isProxy=${looksLikeProxyChallenge(details)} first=${details.firstAuthAttempt} url=${details.url}`)
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
    logMain('info', `[login] proxy credential resolved store=${storeId} proxy=${String(binding?.proxy_id || '')} found=${!!cred} user=${cred?.username || ''}`)
    if (cred && cred.username) {
      lastProxyAuth.set(storeId, { at: Date.now(), username: cred.username, proxyId: binding.proxy_id })
      callback(cred.username, cred.password)
    } else {
      callback() // 无凭据 → 取消认证（请求将 407 失败，不弹系统框）
    }
  } catch (err) {
    logMain('error', `[login] 代理凭据注入失败 store=${storeId}: ${String(err)}`)
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
    logMain('info', `[login] app-level challenge resolved store=${String(storeId || '')} proxy=${looksLikeProxyChallenge(loginDetails)} url=${details.url}`)
    if (!storeId) { callback(); return }
    if (isDuplicateChallenge(storeId, details.url)) {
      logMain('info', `[login] 1s 内重复挑战，直接取消 store=${storeId}`)
      callback()
      return
    }
    handleLoginChallenge(storeId, loginDetails, callback)
  })
}

async function configureProxy(sess: Session, storeId: string): Promise<void> {
  const db = getDatabase()
  
  // 查询店铺绑定的代理
  const binding = db.prepare(`
    SELECT sp.mode, p.type, p.host, p.port, p.username_ref, p.password_ref
    FROM store_proxies sp
    LEFT JOIN proxies p ON sp.proxy_id = p.id
    WHERE sp.store_id = ?
  `).get(storeId) as { mode: string; type?: string; host?: string; port?: number; username_ref?: string; password_ref?: string } | undefined
  
  try {
    if (!binding || binding.mode === 'direct' || !binding.host || !binding.port) {
      // 直连模式；代理被删除后也必须显式回落直连。
      await sess.setProxy({ mode: 'direct' })
      return
    }

    // 构建代理规则 - §4.3 不内嵌凭据（407 由 login 事件注入）
    const proxyRules = `${binding.type}://${binding.host}:${binding.port}`
    await sess.setProxy({ mode: 'fixed_servers', proxyRules })
  } catch (err) {
    logMain('error', `[proxy] setProxy 失败 store=${storeId}: ${String(err)}`)
    throw err
  }
}

/**
 * 重新应用代理配置（proxy:bind / proxy:update 后调用；session 已创建时）
 */
export async function reconfigureProxy(storeId: string): Promise<void> {
  const sess = activeSessions.get(storeId)
  if (!sess) return
  // 串行化首次配置与后续绑定/修改，避免旧代理配置覆盖新配置。
  const previous = sessionReady.get(storeId) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => configureProxy(sess, storeId))
  sessionReady.set(storeId, next)
  await next
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
  // （用户会以为"清数据没生效"）。
  //
  // 按域清（带 origin）时**不能**一概丢弃：同一个店铺可能有多个域的登录态，按域清只该影响那一个域。
  // 这里改成"立刻按当前状态重拍快照"——快照要么反映清完后的真实 Cookie（还有别的域），
  // 要么在会话级 Cookie 全空时被 snapshotStoreSession 自动删除（全量清空的场景）。
  // 此前 `&& !origin` 的写法让按域清完全不动快照，重启后同名 Cookie 被旧快照覆盖回来。
  if (types.includes('cookies')) {
    void snapshotStoreSession(storeId).catch(() => { /* 快照失败不阻塞清理 */ })
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
export interface CloseStoreSessionOptions {
  /** 删除店铺时关闭流程不应再异步写回旧 Cookie 快照。 */
  persist?: boolean
}

export function closeStoreSession(storeId: string, options: CloseStoreSessionOptions = {}): void {
  if (activeSessions.has(storeId)) {
    if (options.persist !== false) {
      void snapshotStoreSession(storeId).catch(() => { /* 快照失败不阻塞关闭 */ })
    }
    activeSessions.delete(storeId)
    sessionReady.delete(storeId)
  }
  untrackStoreSession(storeId)
}

/**
 * 获取所有活动的 session
 */
export function getActiveSessions(): Map<string, Session> {
  return activeSessions
}
