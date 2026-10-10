import { createHash, randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { onCustomerServiceSessionClosed, waitForCustomerServiceSessionReady } from '../browser/session-manager'
import { getStore, listStores } from '../stores/store-manager'
import { getDatabase } from '../db/database'
import { emitToRenderer } from '../browser/window-manager'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { isCustomerMessageCheckFresh } from '@shared/contracts/customer-service'
import { assertNavigableUrl } from '@shared/navigation'
import { isAppLocked } from './security-manager'
import type {
  CustomerMessageCheck,
  CustomerMessageEvidence,
  CustomerMessageFreshness,
  CustomerMessageStatus,
  CustomerMessageStatusList
} from '@shared/contracts/customer-service'
import { logMain } from './logger'

/** 客服入口是后台检查来源，不会被挂到客服工作区的可见 DOM。 */
export interface CustomerMessagePlatformConfig {
  platform: string
  url: string
  /** 页面改版时用于增加语义信号，不依赖易变的构建 class。 */
  keywords: string[]
}

export const CUSTOMER_MESSAGE_PLATFORMS: Record<string, CustomerMessagePlatformConfig> = {
  抖店: { platform: '抖店', url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace', keywords: ['客服', '会话', '消息', '接待'] },
  拼多多: { platform: '拼多多', url: 'https://mms.pinduoduo.com/chat-merchant/index.html', keywords: ['客服', '会话', '消息', '聊天'] },
  快手小店: { platform: '快手小店', url: 'https://im.kwaixiaodian.com/workbench', keywords: ['客服', '会话', '消息', '接待'] },
  微信小店: { platform: '微信小店', url: 'https://store.weixin.qq.com/shop/kf', keywords: ['客服', '会话', '消息', '接待'] }
}

export interface CustomerMessageProbeResult {
  documentReady: boolean
  messageContext: boolean
  unreadCount: number | null
  conversationCount: number | null
  unreadSignals: number
  conversationSignals: number
  loginSignals: number
}

/**
 * 后台页面最多等待一轮页面异步渲染：客服页面通常先渲染壳，再通过接口填充
 * 会话列表和未读徽标。没有数量证据时不能把「壳已出现」当成最终结果。
 */
export const CUSTOMER_MESSAGE_PROBE_TIMEOUT_MS = 15_000

/**
 * 采集脚本只回传计数和布尔信号，绝不回传 body.innerText、聊天正文、昵称或完整 DOM。
 * 选择器只使用语义属性/关键词；平台的构建哈希 class 不会写入长期适配规则。
 */
export function buildCustomerMessageProbeScript(keywords: string[]): string {
  return `(() => {
    const normalize = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const visible = el => {
      try {
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      } catch { return false; }
    };
    const parseExactCount = value => {
      const text = normalize(value);
      if (!text || /\\+/.test(text)) return null;
      const match = text.match(/(?:^|[^0-9])([0-9]{1,5})(?:$|[^0-9])/);
      if (!match) return null;
      const count = Number(match[1]);
      return Number.isSafeInteger(count) && count >= 0 && count <= 99999 ? count : null;
    };
    const walk = (root, out) => {
      if (!root || !root.querySelectorAll) return;
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, out);
      }
    };
    const nodes = [];
    walk(document, nodes);
    const bodyText = normalize(document.body && document.body.innerText).slice(0, 12000).toLowerCase();
    const terms = ${JSON.stringify(keywords.map(value => String(value).toLowerCase()))};
    const contextTerms = ['客服', '会话', '消息', '聊天', '接待', 'customer service', 'conversation', 'chat', 'inbox'];
    const contextHits = [...new Set([...terms, ...contextTerms])].filter(term => term && bodyText.includes(term)).length;
    const loginTerms = ['请登录', '立即登录', '扫码登录', '登录后', '重新登录', 'sign in', 'log in', 'login'];
    const loginHits = loginTerms.filter(term => bodyText.includes(term)).length;
    const unreadNodes = nodes.filter(el => {
      if (!visible(el)) return false;
      const marker = normalize([el.id, el.className, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('data-testid'), el.getAttribute && el.getAttribute('data-test')].join(' ')).toLowerCase();
      return /unread|未读|消息数|待回复/.test(marker);
    });
    const unreadValues = unreadNodes.map(el => parseExactCount(el.innerText || el.textContent)).filter(value => value != null);
    const unreadCount = unreadValues.length ? Math.max(...unreadValues) : null;
    const conversationMarkers = /conversation|session|chat|message-list|客服|会话|接待|dialog/;
    const conversationNodes = nodes.filter(el => {
      if (!visible(el)) return false;
      const marker = normalize([el.id, el.className, el.getAttribute && el.getAttribute('role'), el.getAttribute && el.getAttribute('data-testid')].join(' ')).toLowerCase();
      return conversationMarkers.test(marker);
    });
    const itemNodes = nodes.filter(el => {
      if (!visible(el)) return false;
      const marker = normalize([el.id, el.className, el.getAttribute && el.getAttribute('role'), el.getAttribute && el.getAttribute('data-testid')].join(' ')).toLowerCase();
      return /conversation[-_ ]?item|session[-_ ]?item|chat[-_ ]?item|message[-_ ]?item|role=listitem/.test(marker);
    });
    const conversationCount = itemNodes.length ? Math.min(itemNodes.length, 99999) : null;
    return {
      documentReady: !!document && !!document.body,
      messageContext: contextHits > 0 || conversationNodes.length > 0 || unreadNodes.length > 0,
      unreadCount,
      conversationCount,
      unreadSignals: unreadNodes.length,
      conversationSignals: conversationNodes.length,
      loginSignals: loginHits
    };
  })()`
}

export function interpretCustomerMessageProbe(
  probe: Partial<CustomerMessageProbeResult> | null | undefined,
  _capturedAt = Date.now()
): Pick<CustomerMessageCheck, 'status' | 'unreadCount' | 'conversationCount' | 'reasonCode' | 'message' | 'evidence'> {
  const evidence: CustomerMessageEvidence = {
    documentReady: probe?.documentReady === true,
    messageContext: probe?.messageContext === true,
    unreadSignals: Number.isFinite(probe?.unreadSignals) ? Math.max(0, Number(probe?.unreadSignals)) : 0,
    conversationSignals: Number.isFinite(probe?.conversationSignals) ? Math.max(0, Number(probe?.conversationSignals)) : 0,
    loginSignals: Number.isFinite(probe?.loginSignals) ? Math.max(0, Number(probe?.loginSignals)) : 0
  }
  const unreadCount = Number.isInteger(probe?.unreadCount) && Number(probe?.unreadCount) >= 0 ? Number(probe?.unreadCount) : null
  const conversationCount = Number.isInteger(probe?.conversationCount) && Number(probe?.conversationCount) >= 0 ? Number(probe?.conversationCount) : null
  if (!evidence.documentReady) return { status: 'ERROR', unreadCount: null, conversationCount: null, reasonCode: 'PAGE_NOT_READY', message: '客服页面尚未完成加载', evidence }
  if (evidence.loginSignals > 0 && unreadCount == null && conversationCount == null && evidence.unreadSignals === 0 && evidence.conversationSignals === 0) return { status: 'LOGIN_REQUIRED', unreadCount: null, conversationCount: null, reasonCode: 'LOGIN_REQUIRED', message: '平台客服页面需要登录', evidence }
  if (!evidence.messageContext) return { status: 'PAGE_CHANGED', unreadCount: null, conversationCount: null, reasonCode: 'MESSAGE_CONTEXT_NOT_FOUND', message: '未找到客服消息区域，可能是未登录或页面已改版', evidence }
  if (unreadCount == null && conversationCount == null) return { status: 'NOT_VERIFIED', unreadCount: null, conversationCount: null, reasonCode: 'COUNT_EVIDENCE_NOT_FOUND', message: '已找到客服页面，但没有可核验的数量证据', evidence }
  return { status: 'AVAILABLE', unreadCount, conversationCount, reasonCode: 'DOM_EVIDENCE_CAPTURED', message: '已从平台客服页面读取消息摘要', evidence }
}

interface MonitorRuntime {
  now: () => number
  borrowPage: (storeId: string) => { waitForWebContents: (timeoutMs?: number) => Promise<WebContents | null>; release: () => void }
  emit: (channel: string, payload: unknown) => void
  closeAll?: () => void
  isLocked?: () => boolean
}

/**
 * 后台客服检查使用隐藏 BrowserWindow + 客服专用 partition。
 * 不能借用经营工作台的 collection tab：即使 tab 不显示，它仍会共享经营 Cookie，
 * 并可能让同一 Session 的代理/页面状态互相污染。窗口按店铺复用，检查结束只释放租约，
 * 直到监控停止时才销毁，从而保留平台页面的登录与连接状态。
 */
const customerServiceMonitorWindows = new Map<string, BrowserWindow>()

/** 隐藏监控窗同样承载远程页面，不能因为它不可见就放宽导航边界。 */
function isAllowedCustomerMonitorNavigation(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const safeUrl = assertNavigableUrl(url)
    return ['http:', 'https:'].includes(new URL(safeUrl).protocol)
  } catch {
    return false
  }
}

function installCustomerMonitorWindowSecurity(monitorWindow: BrowserWindow): void {
  const wc = monitorWindow.webContents
  try {
    wc.setWindowOpenHandler(({ url }: { url: string }) => {
      // 监控页面没有用户可操作的弹窗宿主；拒绝所有 window.open，避免远程页
      // 借隐藏窗口创建未受控的原生窗口。登录仍由可见客服工作区完成。
      logMain('warn', `customer-service monitor: blocked popup protocol=${(() => { try { return new URL(url).protocol } catch { return '<invalid>' } })()}`)
      return { action: 'deny' }
    })
  } catch { /* Electron 版本没有该 API 时仍继续安装导航钩子 */ }
  const allowNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedCustomerMonitorNavigation(url)) return
    event.preventDefault()
    logMain('warn', 'customer-service monitor: blocked unsafe navigation')
  }
  try { wc.on('will-navigate', allowNavigation) } catch { /* 页面销毁时幂等 */ }
  try { wc.on('will-redirect', allowNavigation) } catch { /* 页面销毁时幂等 */ }
}

function getCustomerServiceMonitorWindow(storeId: string): BrowserWindow {
  const existing = customerServiceMonitorWindows.get(storeId)
  if (existing && !existing.isDestroyed()) return existing
  const monitorWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      partition: `persist:customer-service_${storeId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  monitorWindow.webContents.setBackgroundThrottling(false)
  installCustomerMonitorWindowSecurity(monitorWindow)
  monitorWindow.on('closed', () => {
    if (customerServiceMonitorWindows.get(storeId) === monitorWindow) customerServiceMonitorWindows.delete(storeId)
  })
  customerServiceMonitorWindows.set(storeId, monitorWindow)
  return monitorWindow
}

function borrowCustomerServicePage(storeId: string): MonitorRuntime['borrowPage'] extends (storeId: string) => infer R ? R : never {
  // 店铺删除与定时检查可能同时发生。check() 先读取到店铺后，删除流程
  // 仍可能在下一次调度前将它移入回收站；创建隐藏窗口前再做一次同步存在性
  // 检查，避免 closeCustomerServiceSession() 已经发出关闭通知后才生成孤儿窗口。
  if (!getStore(storeId)) {
    return {
      async waitForWebContents(): Promise<WebContents | null> { return null },
      release(): void { /* 无窗口可释放 */ }
    }
  }
  // check() 与真正创建隐藏窗口之间没有异步边界，但锁定事件可能已经在
  // check() 的首次判定之后到达。创建前再挡一次，避免锁定态懒创建新的
  // BrowserWindow/Session；否则 pauseForAppLock() 先跑完后，新窗口会漏过
  // closeAll()，一直留到应用退出。
  if (isAppLocked()) {
    return {
      async waitForWebContents(): Promise<WebContents | null> { return null },
      release(): void { /* 无窗口可释放 */ }
    }
  }
  const monitorWindow = getCustomerServiceMonitorWindow(storeId)
  let released = false
  return {
    async waitForWebContents(timeoutMs = 15_000): Promise<WebContents | null> {
      if (released || isAppLocked() || monitorWindow.isDestroyed()) return null
      try {
        await Promise.race([
          waitForCustomerServiceSessionReady(storeId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SESSION_TIMEOUT')), timeoutMs))
        ])
      } catch (error) {
        // 窗口在 waitForWebContents() 之前已被创建，而删除流程可能在这里
        // 先一步移除店铺；此时还没有客服 Session 关闭监听可以代为回收窗口。
        if (String((error as Error)?.message || error).includes('STORE_NOT_FOUND')) {
          closeCustomerServiceMonitorWindow(storeId)
        }
        return null
      }
      return released || isAppLocked() || monitorWindow.isDestroyed() ? null : monitorWindow.webContents
    },
    release(): void { released = true }
  }
}

function closeCustomerServiceMonitorWindows(): void {
  for (const monitorWindow of customerServiceMonitorWindows.values()) {
    try { if (!monitorWindow.isDestroyed()) monitorWindow.destroy() } catch { /* 关闭时幂等 */ }
  }
  customerServiceMonitorWindows.clear()
}

/** 店铺移入回收站或彻底删除时，只回收该店铺的隐藏监控窗口。 */
function closeCustomerServiceMonitorWindow(storeId: string): void {
  const monitorWindow = customerServiceMonitorWindows.get(storeId)
  if (!monitorWindow) return
  customerServiceMonitorWindows.delete(storeId)
  try { if (!monitorWindow.isDestroyed()) monitorWindow.destroy() } catch { /* 幂等清理 */ }
}

// Session 生命周期由 Main 统一协调；避免店铺管理器直接依赖本服务，减少循环依赖。
onCustomerServiceSessionClosed(closeCustomerServiceMonitorWindow)

function defaultRuntime(): MonitorRuntime {
  return {
    now: () => Date.now(),
    borrowPage: borrowCustomerServicePage,
    emit: emitToRenderer,
    closeAll: closeCustomerServiceMonitorWindows,
    // 安全状态读取失败时监控应停在安全侧，不能在数据库/锁状态异常时继续碰远程页。
    isLocked: () => { try { return isAppLocked() } catch { return true } }
  }
}

function sourceHash(url: string | null): string | null {
  return url ? createHash('sha256').update(url).digest('hex') : null
}

interface CustomerMessageCheckRow {
  store_id: string
  platform: string
  status: string
  unread_count: number | null
  conversation_count: number | null
  reason_code: string
  message: string
  captured_at: number
  source_url_hash: string | null
  evidence_json: string | null
}

function mapRow(row: CustomerMessageCheckRow, now: number): CustomerMessageCheck {
  let evidence: CustomerMessageEvidence | null = null
  try { evidence = row.evidence_json ? JSON.parse(row.evidence_json) : null } catch { evidence = null }
  return {
    storeId: String(row.store_id), platform: String(row.platform), status: String(row.status) as CustomerMessageStatus,
    unreadCount: row.unread_count == null ? null : Number(row.unread_count),
    conversationCount: row.conversation_count == null ? null : Number(row.conversation_count),
    reasonCode: String(row.reason_code), message: String(row.message), capturedAt: Number(row.captured_at),
    freshness: isCustomerMessageCheckFresh(Number(row.captured_at), now) ? 'FRESH' : 'STALE',
    sourceUrlHash: row.source_url_hash ? String(row.source_url_hash) : null, evidence
  }
}

export class CustomerMessageMonitor {
  private readonly runtime: MonitorRuntime
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private started = false
  /** 锁定时只在原本运行过的实例上恢复，手动 stop 不会被解锁动作偷偷重启。 */
  private pausedForLock = false
  private lifecycleVersion = 0
  private readonly inFlight = new Set<string>()

  constructor(runtime: MonitorRuntime = defaultRuntime()) { this.runtime = runtime }

  list(storeId?: string, limit = 100): CustomerMessageStatusList {
    const computedAt = this.runtime.now()
    const rows = getDatabase().prepare(`
      SELECT c.* FROM customer_message_checks c
      JOIN stores s ON s.id = c.store_id AND s.deleted_at IS NULL
      WHERE c.id = (SELECT c2.id FROM customer_message_checks c2 WHERE c2.store_id = c.store_id ORDER BY c2.captured_at DESC, c2.rowid DESC LIMIT 1)
      ${storeId ? 'AND c.store_id = ?' : ''}
      ORDER BY c.captured_at DESC LIMIT ?
    `).all(...(storeId ? [storeId, Math.min(1000, Math.max(1, limit))] : [Math.min(1000, Math.max(1, limit))])) as CustomerMessageCheckRow[]
    return { computedAt, items: rows.map(row => mapRow(row, computedAt)) }
  }

  async check(storeId: string): Promise<CustomerMessageCheck> {
    if (this.isPaused()) return this.lockedResult(storeId)
    // 先确认店铺仍是活动记录，再判断是否已有同店铺检查在途。
    // 删除竞态下不能因为旧检查还没结束就给已删除店铺返回 CHECKING。
    const store = getStore(storeId)
    if (!store) throw new Error('STORE_NOT_FOUND')
    if (this.inFlight.has(storeId)) {
      const checking = this.transient(storeId, store?.platform || '未知平台', 'CHECKING', 'CHECK_ALREADY_RUNNING', '消息检查正在进行', null)
      this.emit(checking)
      return checking
    }
    const lifecycleVersion = this.lifecycleVersion
    const config = CUSTOMER_MESSAGE_PLATFORMS[store.platform]
    if (!config) return this.record(storeId, store.platform, {
      status: 'NOT_VERIFIED', unreadCount: null, conversationCount: null,
      reasonCode: 'PLATFORM_UNSUPPORTED', message: '该平台暂未配置客服消息检查入口', evidence: null
    }, null, lifecycleVersion)
    this.inFlight.add(storeId)
    if (this.isPaused(lifecycleVersion)) {
      this.inFlight.delete(storeId)
      return this.lifecycleResult(storeId, store.platform, lifecycleVersion)
    }
    this.emit(this.transient(storeId, store.platform, 'CHECKING', 'CHECK_IN_PROGRESS', '正在检查平台客服页面', config.url))
    try {
      let lease: ReturnType<MonitorRuntime['borrowPage']> | null = null
      try {
        lease = this.runtime.borrowPage(storeId)
        const wc = await lease.waitForWebContents(20_000)
        if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, store.platform, lifecycleVersion)
        if (!wc || wc.isDestroyed()) return await this.record(storeId, store.platform, {
          status: 'ERROR', unreadCount: null, conversationCount: null, reasonCode: 'PAGE_NOT_READY', message: '隐藏客服页面未就绪，请稍后重试', evidence: null
        }, config.url, lifecycleVersion)
        await this.withTimeout(wc.loadURL(config.url), 25_000)
        if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, store.platform, lifecycleVersion)
        const probe = await this.waitForProbe(wc, config.keywords, CUSTOMER_MESSAGE_PROBE_TIMEOUT_MS, lifecycleVersion)
        if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, store.platform, lifecycleVersion)
        return await this.record(storeId, store.platform, interpretCustomerMessageProbe(probe, this.runtime.now()), config.url, lifecycleVersion)
      } catch (error) {
        const message = String((error as Error)?.message || error)
        const timeout = message.includes('TIMEOUT')
        return await this.record(storeId, store.platform, {
          status: timeout ? 'ERROR' : 'ERROR', unreadCount: null, conversationCount: null,
          reasonCode: timeout ? 'PAGE_TIMEOUT' : 'PAGE_LOAD_FAILED', message: timeout ? '客服页面加载超时' : '客服页面读取失败', evidence: null
        }, config.url, lifecycleVersion)
      } finally { try { lease?.release() } catch { /* 页面关闭时释放租约必须幂等 */ } }
    } finally { this.inFlight.delete(storeId) }
  }

  start(): void {
    if (this.started || this.isLocked()) return
    this.pausedForLock = false
    this.started = true
    const tick = () => { void this.checkAll().catch(error => logMain('warn', `[customer-service] 调度失败: ${String((error as Error)?.message || error).slice(0, 160)}`)) }
    this.startupTimer = setTimeout(tick, 15_000)
    if (typeof this.startupTimer.unref === 'function') this.startupTimer.unref()
    this.timer = setInterval(tick, 45_000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.timer) clearInterval(this.timer)
    this.startupTimer = null
    this.timer = null
    this.started = false
    this.pausedForLock = false
    this.lifecycleVersion += 1
    try { this.runtime.closeAll?.() } catch { /* 监控停止不应阻塞应用退出 */ }
  }

  /** 应用锁钩子：停止调度并销毁隐藏页面，防止锁定态继续读取远程内容。 */
  pauseForAppLock(): void {
    const shouldResume = this.started
    this.pausedForLock = shouldResume
    this.lifecycleVersion += 1
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.timer) clearInterval(this.timer)
    this.startupTimer = null
    this.timer = null
    this.started = false
    try { this.runtime.closeAll?.() } catch { /* 锁定清理必须幂等 */ }
  }

  /** 解锁钩子：只恢复锁定前已经运行的监控实例。 */
  resumeAfterAppUnlock(): void {
    if (!this.pausedForLock || this.isLocked()) return
    this.pausedForLock = false
    this.start()
  }

  async checkAll(): Promise<void> {
    if (this.isPaused()) return
    let ids: string[]
    try { ids = listStores().map(store => store.id) } catch (error) {
      logMain('warn', `[customer-service] 读取店铺列表失败: ${String((error as Error)?.message || error).slice(0, 160)}`)
      return
    }
    for (let index = 0; index < ids.length; index += 2) {
      if (this.isPaused()) return
      await Promise.all(ids.slice(index, index + 2).map(id => this.check(id).catch(error => {
        logMain('warn', `[customer-service] 检查失败 store=${id}: ${String((error as Error)?.message || error).slice(0, 160)}`)
      })))
    }
  }

  private isPaused(version?: number): boolean {
    return this.isLocked() || this.pausedForLock || (version !== undefined && version !== this.lifecycleVersion)
  }

  private isLocked(): boolean {
    try { return this.runtime.isLocked?.() === true } catch { return true }
  }

  private lockedResult(storeId: string, platform = '未知平台'): CustomerMessageCheck {
    return this.transient(storeId, platform, 'ERROR', 'APP_LOCKED', '应用已锁定，客服监控已暂停', null)
  }

  /**
   * 手动停止/店铺生命周期变化与应用锁都可能让一次检查失效。
   * 失效结果只能返回给当前调用方，不能写入台账或广播；手动停止不能伪装成锁定。
   */
  private lifecycleResult(storeId: string, platform: string, version: number): CustomerMessageCheck {
    if (this.isLocked() || this.pausedForLock) return this.lockedResult(storeId, platform)
    if (version !== this.lifecycleVersion) return this.transient(storeId, platform, 'ERROR', 'MONITOR_STOPPED', '客服监控已停止，本次检查结果已丢弃', null)
    return this.lockedResult(storeId, platform)
  }

  private async waitForProbe(wc: WebContents, keywords: string[], timeoutMs: number, lifecycleVersion?: number): Promise<CustomerMessageProbeResult> {
    const deadline = this.runtime.now() + timeoutMs
    let last: CustomerMessageProbeResult = { documentReady: false, messageContext: false, unreadCount: null, conversationCount: null, unreadSignals: 0, conversationSignals: 0, loginSignals: 0 }
    while (this.runtime.now() < deadline) {
      // 锁定/停止可能发生在两次探针之间；不要再对远程页面发起下一次
      // executeJavaScript，调用方随后会把本次结果收敛为 APP_LOCKED。
      if (this.isPaused(lifecycleVersion) || wc.isDestroyed()) return last
      const raw = await wc.executeJavaScript(buildCustomerMessageProbeScript(keywords), true).catch(() => null)
      if (this.isPaused(lifecycleVersion)) return last
      if (raw && typeof raw === 'object') {
        last = raw as CustomerMessageProbeResult
        // 登录页已经有明确的否定证据，可以立即结束；客服外壳本身还不够，
        // 必须等到至少一个可核验数字出现，或等超时后如实报告未验证。
        if (last.documentReady && last.loginSignals > 0 && !last.messageContext && last.unreadCount == null && last.conversationCount == null) return last
        if (last.documentReady && last.messageContext && (last.unreadCount != null || last.conversationCount != null)) return last
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return last
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PAGE_TIMEOUT')), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return await Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
  }

  private async record(storeId: string, platform: string, result: Pick<CustomerMessageCheck, 'status' | 'unreadCount' | 'conversationCount' | 'reasonCode' | 'message' | 'evidence'>, url: string | null, lifecycleVersion: number): Promise<CustomerMessageCheck> {
    // 锁定或暂停可能发生在探针返回与写库之间；此时不应把锁定期间的
    // 远程页面结果落入本地台账，也不应继续向 Renderer 广播旧页面证据。
    if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, platform, lifecycleVersion)
    const capturedAt = this.runtime.now()
    const freshness: CustomerMessageFreshness = isCustomerMessageCheckFresh(capturedAt, capturedAt) ? 'FRESH' : 'STALE'
    const item: CustomerMessageCheck = { storeId, platform, ...result, capturedAt, freshness, sourceUrlHash: sourceHash(url) }
    // DB 写入是同步操作；在进入它之前再校验一次版本，避免 stop() 已经发生后把
    // 旧页面结果落盘。广播前也重复校验，防止未来改成异步 DB 驱动时回归。
    if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, platform, lifecycleVersion)
    // 用 INSERT ... SELECT 把“仍是活动店铺”的检查和写入放在同一条 SQLite
    // 语句里。彻底删除可能与后台检查并发；先 SELECT 再 INSERT 会在外键级联后
    // 抛错，导致一次本应被丢弃的迟到页面结果冒泡成 IPC INTERNAL_ERROR。
    const inserted = getDatabase().prepare(`
      INSERT INTO customer_message_checks(
        id,store_id,platform,status,unread_count,conversation_count,reason_code,message,source_url_hash,evidence_json,captured_at
      )
      SELECT ?,s.id,?,?,?,?,?,?,?,?,?
      FROM stores s
      WHERE s.id = ? AND s.deleted_at IS NULL
    `).run(
      randomUUID(), item.platform, item.status, item.unreadCount, item.conversationCount,
      item.reasonCode, item.message, item.sourceUrlHash, item.evidence ? JSON.stringify(item.evidence) : null,
      item.capturedAt, item.storeId
    )
    if (!inserted.changes) {
      return this.transient(storeId, platform, 'ERROR', 'STORE_NOT_FOUND', '店铺不存在或已删除', url)
    }
    // 客服监控只需要最近一周的状态轨迹，避免周期检查长期增长本地台账。
    try {
      getDatabase().prepare('DELETE FROM customer_message_checks WHERE store_id = ? AND captured_at < ?').run(item.storeId, capturedAt - 7 * 24 * 60 * 60 * 1000)
    } catch { /* 清理失败不影响本次摘要返回 */ }
    if (this.isPaused(lifecycleVersion)) return this.lifecycleResult(storeId, platform, lifecycleVersion)
    this.emit(item)
    return item
  }

  private transient(storeId: string, platform: string, status: CustomerMessageStatus, reasonCode: string, message: string, url: string | null): CustomerMessageCheck {
    const capturedAt = this.runtime.now()
    return {
      storeId,
      platform,
      status,
      unreadCount: null,
      conversationCount: null,
      reasonCode,
      message,
      capturedAt,
      freshness: 'FRESH',
      sourceUrlHash: sourceHash(url),
      evidence: null
    }
  }

  private emit(item: CustomerMessageCheck): void {
    try { this.runtime.emit(EVENT_CHANNELS.CUSTOMER_SERVICE_STATUS_CHANGED, item) } catch { /* 窗口尚未创建或已关闭 */ }
  }
}

export const customerMessageMonitor = new CustomerMessageMonitor()
