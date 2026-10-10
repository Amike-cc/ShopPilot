/**
 * 浏览器视图管理器（主窗口内嵌模型）- §4.3 / §8.2
 *
 * 架构：
 * - 主窗口（工作台）是唯一宿主窗口；每个店铺标签页由 Renderer DOM 中受控的
 *   Electron `<webview>` 承载，主进程只保存并操作已注册的 guest WebContents。
 * - 同一时刻仅允许 displayedStoreId 的活动标签页接收交互；切换店铺/标签页由 Renderer
 *   控制 webview 的可见性，不再把原生 View 摘挂到 BrowserWindow.contentView。
 * - 未显示的标签页在温缓存/冷休眠策略内继续存活（后台加载、状态保留）；
 *   冷休眠只关闭 guest，标签页元数据持久化到 tabs 表，重开后恢复。
 * - WebContents 无 destroy()，销毁用 webContents.close()；Renderer reload 后必须重新注册 guest。
 */

import { BrowserWindow, Menu, clipboard, webContents } from 'electron'
import { getSession, waitForSessionReady } from './shop-session-manager'
import { StorePageLeases } from './page-lease'
import { registerFingerprintTarget, unregisterFingerprintTarget } from './fingerprint-injector'
import {
  buildStoreContextMenu, runStoreMenuAction, toStoreMenuInput, toElectronMenuTemplate,
  type StoreContextMenuParams, type StoreMenuDeps
} from './store-context-menu'
import { buildElementProbeScript, formatElementProbe, type ElementProbeResult } from './element-probe'
import { buildElementPickerScript, describePickResult, type ElementPickResult, type PickMode } from './element-picker'
import { getDatabase } from '../db/database'
import { getStore, updateStoreStatus, updateStoreLastActive, onStoreStatusChanged } from '../stores/store-manager'
import { StoreStatus } from '@shared/enums/store-status'
import { assertNavigableUrl } from '@shared/navigation'
export { assertNavigableUrl } from '@shared/navigation'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { logMain } from '../services/logger'
import { randomBytes } from 'crypto'
import {
  DEFAULT_STORE_COLD_SLEEP_AFTER_MS,
  DEFAULT_STORE_WARM_CACHE_LIMIT,
  StoreLifecycleRegistry
} from './store-lifecycle'
import { getActiveDownloadStoreIds, isStoreDownloadActive } from './download-manager'

export interface Tab {
  id: string
  storeId: string
  url: string
  title: string
  isPinned: boolean
  orderIndex: number
  /**
   * 采集专用标签页（应用内部使用）：**不是**用户的活动标签页，界面不把它显示在标签栏、
   * 也不会因为它的存在而切换用户正在看的页面。渲染层仍会为它挂一个隐藏 webview，
   * 这样采集有真实页面可读，而用户的标签页（URL、表单、滚动位置）一点没动。
   */
  internal?: boolean
  /** Renderer DOM <webview> 注册后的 guest 句柄；不向 Renderer 暴露。 */
  webContents?: Electron.WebContents
  guestWebContentsId?: number
  guestAttached?: boolean
}

interface BrowserState {
  tabs: Map<string, Tab>
  activeTabId: string | null
}

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

const browserStates = new Map<string, BrowserState>()

/** 店铺的「独立窗口」逃生入口：不随 browserStates 走，删除店铺时要显式销毁 */
const standaloneWindows = new Map<string, Set<BrowserWindow>>()

let hostWindow: BrowserWindow | null = null
let displayedStoreId: string | null = null
let viewport: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 }

/** guest id -> 已绑定的店铺标签页，防止一个 guest 被重复认领。 */
const guestTabs = new Map<number, Tab>()
/** 注册完成前等待页面句柄的任务/页面工具。 */
const guestWaiters = new Map<string, Set<(wc: Electron.WebContents | null) => void>>()
/** 任务执行期间即使页面未显示也必须保持活动；任务结束后恢复后台节流。 */
const taskAwakeStores = new Set<string>()
/** 后台采集借用店铺页面的租约账本：采集结束按需关页面（见 page-lease.ts）。 */
const pageLeases = new StorePageLeases()

/**
 * 店铺级生命周期：当前店铺保持可交互，最近一次切换的上一家作为温缓存，
 * 其它店铺空闲达到阈值后冷休眠（关闭 guest/WebContents，Session 与标签页记录保留）。
 */
const storeLifecycle = new StoreLifecycleRegistry()
const storeReapTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 店铺级生命周期门禁按 reason 计数；同一原因可被多个并发服务持有。 */
const storeLifecycleBlocks = new Map<string, Map<StoreLifecycleBlockReason, number>>()
const STORE_WARM_CACHE_LIMIT = DEFAULT_STORE_WARM_CACHE_LIMIT
const STORE_COLD_SLEEP_AFTER_MS = DEFAULT_STORE_COLD_SLEEP_AFTER_MS
const STORE_REAP_BLOCK_RETRY_MS = 15_000

export type StoreLifecycleBlockReason = 'task' | 'confirmation' | 'upload' | 'external'

function clearStoreReapTimer(storeId: string): void {
  const timer = storeReapTimers.get(storeId)
  if (!timer) return
  clearTimeout(timer)
  storeReapTimers.delete(storeId)
}

function setStoreLifecycleBlockInternal(storeId: string, reason: StoreLifecycleBlockReason, active: boolean): void {
  const reasons = storeLifecycleBlocks.get(storeId) || new Map<StoreLifecycleBlockReason, number>()
  if (active) {
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
  } else {
    const left = (reasons.get(reason) || 0) - 1
    if (left > 0) reasons.set(reason, left)
    else reasons.delete(reason)
  }
  if (reasons.size > 0) storeLifecycleBlocks.set(storeId, reasons)
  else storeLifecycleBlocks.delete(storeId)
}

function storeLifecycleBlockReasons(storeId: string): string[] {
  const reasons = new Set<string>(storeLifecycleBlocks.get(storeId)?.keys() || [])
  if (taskAwakeStores.has(storeId)) reasons.add('task')
  if (pageLeases.isBorrowed(storeId)) reasons.add('page-lease')
  if (getCollectionTabId(storeId)) reasons.add('collection')
  if (isStoreDownloadActive(storeId)) reasons.add('download')
  if (getStandaloneWindowCount(storeId) > 0) reasons.add('standalone-window')
  return Array.from(reasons).sort()
}

function isStoreLifecycleBlocked(storeId: string): boolean {
  return storeLifecycleBlockReasons(storeId).length > 0
}

function getWarmStoreIdsForReap(): Set<string> {
  return new Set(storeLifecycle.getWarmStoreIds(displayedStoreId, STORE_WARM_CACHE_LIMIT))
}

function scheduleStoreReap(storeId: string): void {
  clearStoreReapTimer(storeId)
  if (!browserStates.has(storeId) || displayedStoreId === storeId) return

  const record = storeLifecycle.get(storeId)
  if (!record) return
  if (getWarmStoreIdsForReap().has(storeId)) return
  const delay = Math.max(0, record.lastUsedAt + STORE_COLD_SLEEP_AFTER_MS - Date.now())
  const timer = setTimeout(() => {
    storeReapTimers.delete(storeId)
    reapStoreIfEligible(storeId)
  }, Math.max(1, delay))
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  storeReapTimers.set(storeId, timer)
}

function scheduleAllStoreReaps(): void {
  for (const storeId of browserStates.keys()) scheduleStoreReap(storeId)
}

function reapStoreIfEligible(storeId: string): void {
  if (!browserStates.has(storeId) || displayedStoreId === storeId) return
  if (getWarmStoreIdsForReap().has(storeId)) return
  if (!storeLifecycle.isIdle(storeId, Date.now(), STORE_COLD_SLEEP_AFTER_MS)) {
    scheduleStoreReap(storeId)
    return
  }
  if (isStoreLifecycleBlocked(storeId)) {
    // 阻塞解除时 setStoreTaskActivity/setStoreLifecycleBlock/租约归还会重新调度；
    // 这里保留一个低频兜底，防止第三方生命周期标记没有走解除回调导致永久常驻。
    const timer = setTimeout(() => {
      storeReapTimers.delete(storeId)
      reapStoreIfEligible(storeId)
    }, STORE_REAP_BLOCK_RETRY_MS)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    storeReapTimers.set(storeId, timer)
    return
  }
  try {
    closeStoreBrowser(storeId)
    logMain('info', `[browser] 店铺冷休眠完成 store=${storeId} idleMs>=${STORE_COLD_SLEEP_AFTER_MS}`)
  } catch (error) {
    logMain('warn', `[browser] 店铺冷休眠失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 180)}`)
    scheduleStoreReap(storeId)
  }
}

function applyBackgroundThrottling(tab: Tab): void {
  const wc = tab.webContents
  if (!wc || wc.isDestroyed()) return
  const state = browserStates.get(tab.storeId)
  const isActiveVisibleTab = displayedStoreId === tab.storeId && state?.activeTabId === tab.id
  const shouldThrottle = !isActiveVisibleTab && !taskAwakeStores.has(tab.storeId)
  try { wc.setBackgroundThrottling(shouldThrottle) } catch { /* 页面正在销毁 */ }
}

function applyStoreBackgroundThrottling(storeId: string): void {
  const state = browserStates.get(storeId)
  if (!state) return
  for (const tab of state.tabs.values()) applyBackgroundThrottling(tab)
}

/** 任务引擎调用：后台任务期间暂不节流该店铺页面。 */
export function setStoreTaskActivity(storeId: string, active: boolean): void {
  if (active) taskAwakeStores.add(storeId)
  else taskAwakeStores.delete(storeId)
  // 任务结束也算一次后台使用：给页面一个完整冷休眠窗口，避免刚写完结果就被回收。
  if (browserStates.has(storeId)) storeLifecycle.used(storeId, 'background')
  applyStoreBackgroundThrottling(storeId)
  scheduleAllStoreReaps()
}

/**
 * 供需要长时间占用页面的主进程服务使用（例如上传/详情采集）。
 * 这是显式生命周期门禁，不把页面内部状态或任意 DOM 活动猜成“正在使用”。
 */
export function setStoreLifecycleBlock(
  storeId: string,
  reason: StoreLifecycleBlockReason,
  active: boolean
): void {
  setStoreLifecycleBlockInternal(storeId, reason, active)
  if (active && browserStates.has(storeId)) storeLifecycle.used(storeId, 'background')
  scheduleAllStoreReaps()
}

// 店铺状态由 Main 统一计算，Renderer 只接收安全的 storeId/status 摘要。
// 部分纯适配器单测会替换 store-manager 模块，只提供 CRUD 方法；兼容该最小 mock。
if (typeof onStoreStatusChanged === 'function') {
  onStoreStatusChanged((storeId, status) => {
    emit(EVENT_CHANNELS.STORE_STATUS_CHANGED, { storeId, status })
  })
}

/**
 * 打开/关闭店铺浏览器只说明"窗口开没开"，**不是**登录证据。
 *
 * 登录结论只由平台适配器给出（`platform-login-service.storeStatusForLoginResult`）：
 * 明确证据 → `online` / `needs_login`；拿不到证据 → **不改状态**。
 * 所以这里**不能**无条件写 `offline`（2026-10-02 修）——适配器的正向证据只存在于后台首页
 * （经营数据锚点）和商品列表页，店铺停在发布页/订单页/发票页时永远拿不到证据，无条件写
 * `offline` 会让"明明登录着、页面刚代填成功"的店铺被永久显示成离线。真机复现：微信小店
 * 16:51:05 被这次打开打回 `offline`，随后 3 秒一轮的复核在发布页上恒为 UNKNOWN，
 * 状态再也没回到 online（同一时刻 `[product-publish] 打开发布页 reached=true 代填=1` 成功）。
 * 这与"未知证据不得当作否定证据"是同一条纪律（见 docs/product-profiles.md §7.2①）。
 *
 * 唯一要在这里推进的是**从未确认过登录**的新店：`incomplete -> offline`（§9.1 状态机的起点），
 * 否则新店会一直停在 `incomplete`，发布预检会按"店铺配置不完整"阻断。
 */
function markBrowserWindowState(storeId: string): void {
  let current: string | undefined
  try { current = getStore(storeId)?.status } catch { return /* 取不到就什么都不改 */ }
  if (current === StoreStatus.INCOMPLETE) updateStoreStatus(storeId, StoreStatus.OFFLINE)
}

function tabKey(storeId: string, tabId: string): string {
  return `${storeId}:${tabId}`
}

function notifyGuestWaiters(tab: Tab): void {
  const key = tabKey(tab.storeId, tab.id)
  const waiters = guestWaiters.get(key)
  if (!waiters) return
  guestWaiters.delete(key)
  const wc = tab.webContents && !tab.webContents.isDestroyed() ? tab.webContents : null
  waiters.forEach(resolve => { try { resolve(wc) } catch { /* ignore */ } })
}

function generateTabId(): string {
  return `tab_${randomBytes(16).toString('hex')}`
}

/**
 * 页面**主动**导航的白名单判定（§10.1）：站点内跳转、登录重定向都是 http(s)，
 * 交给 assertNavigableUrl 判定即可；file:/javascript:/data: 一律不放行。
 *
 * 不抛错是刻意的：本函数跑在 Electron 的 will-navigate 回调里，异常逃出去会变成主进程
 * uncaughtException（表现为"点链接应用崩"）。空值/无法解析的目标按"未知即拒绝"处理。
 */
function isAllowedPageNavigation(targetUrl: string): boolean {
  if (!targetUrl) return false
  try {
    assertNavigableUrl(targetUrl)
    return true
  } catch {
    return false
  }
}

/** 标签页崩溃自动重载的节流表（tabId → 上次自动重载时间），防崩溃-重载死循环 */
const TAB_RELOAD_MIN_INTERVAL_MS = 5 * 60 * 1000
const tabReloadGuard = new Map<string, number>()
/** did-navigate-in-page 的落库节流（tabId → 上次落库时间）；与 tabReloadGuard 同生命周期清理 */
const inPageSaveAt = new Map<string, number>()

/** §8.2：注入宿主（主）窗口 */
export function setBrowserHostWindow(win: BrowserWindow): void {
  hostWindow = win
  scheduleAllStoreReaps()
  win.on('closed', () => {
    hostWindow = null
    displayedStoreId = null
    for (const storeId of storeReapTimers.keys()) clearStoreReapTimer(storeId)
    guestTabs.clear()
    guestWaiters.forEach(waiters => waiters.forEach(resolve => resolve(null)))
    guestWaiters.clear()
  })
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}

/** 渲染层上报 BrowserViewport 区域（DIP，相对内容区） */
export function setViewportBounds(bounds: ViewportBounds): void {
  // 渲染层数值直接透传 setBounds：NaN/Infinity 会抛错，先洗成有限数并限幅
  const clean = (v: unknown) => Number.isFinite(v) ? Number(v) : 0
  viewport = {
    x: clean(bounds?.x),
    y: clean(bounds?.y),
    width: Math.min(Math.max(clean(bounds?.width), 0), 16384),
    height: Math.min(Math.max(clean(bounds?.height), 0), 16384)
  }
  // DOM <webview> 自己由 Renderer 的 CSS 约束尺寸；该 IPC 只保留给旧页面与诊断日志。
  logMain('info', `browser:setViewport（兼容记录）x=${viewport.x} y=${viewport.y} w=${viewport.width} h=${viewport.height} 近似可见区=${effectiveViewport().width}×${effectiveViewport().height}`)
}

/** 向渲染层推送事件（§7：带 entityId，前端按实体更新） */
function emit(channel: string, payload: any): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.webContents.send(channel, payload)
  }
}

function tabSnapshot(tab: Tab) {
  let loading = false
  try { loading = !!tab.webContents && !tab.webContents.isDestroyed() && tab.webContents.isLoading() } catch { /* ignore */ }
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isPinned: tab.isPinned,
    orderIndex: tab.orderIndex,
    loading,
    guestAttached: !!tab.webContents && !tab.webContents.isDestroyed() && tab.guestAttached === true,
    // 采集专用标签页：渲染层据此"挂隐藏 webview 但不进标签栏、不当作活动页"
    internal: tab.internal === true
  }
}

function emitTabs(storeId: string): void {
  const state = browserStates.get(storeId)
  if (!state) {
    emit(EVENT_CHANNELS.BROWSER_TAB_UPDATED, { storeId, tabs: [], activeTabId: null })
    return
  }
  const tabs = Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex).map(tabSnapshot)
  emit(EVENT_CHANNELS.BROWSER_TAB_UPDATED, { storeId, tabs, activeTabId: state.activeTabId })
}

/**
 * 打开（或显示）店铺浏览器：确保已打开并置为显示状态
 */
export function openStoreBrowser(storeId: string, opts: { display?: boolean; source?: 'renderer' | 'main' } = {}): void {
  if (!hostWindow || hostWindow.isDestroyed()) {
    throw new Error('Host window not available')
  }

  // 由 ShopSessionManager 统一校验店铺并建立/复用底层 Session；
  // 浏览器状态创建前先拒绝不存在或已删除的 storeId。
  getSession(storeId)

  if (!browserStates.has(storeId)) {
    const state: BrowserState = { tabs: new Map(), activeTabId: null }
    browserStates.set(storeId, state)
    storeLifecycle.opened(storeId)
    try {
      restoreTabs(storeId)
      // 打开浏览器只代表 Session 已建立，不能据此推断平台已登录——但**同样不能据此断言未登录**。
      // 只有平台适配器给出明确证据才会切换为 online / needs_login（见 markBrowserWindowState）。
      markBrowserWindowState(storeId)
      // 唤醒等待该店铺的排队任务 run（§4.4：不静默拉起，但已拉起后要放行队列）
      queueMicrotask(() => storeOpenListeners.forEach(cb => { try { cb(storeId) } catch { /* ignore */ } }))
    } catch (error) {
      // 目标店铺打开失败时回滚半初始化状态，保留调用方当前显示店铺和其 guest。
      browserStates.delete(storeId)
      storeLifecycle.forget(storeId)
      clearStoreReapTimer(storeId)
      throw error
    }
  }
  updateStoreLastActive(storeId)
  storeLifecycle.used(storeId, opts.display === false ? 'background' : 'displayed')
  for (const id of browserStates.keys()) applyStoreBackgroundThrottling(id)
  // 界面自己开的店铺（渲染层入口）＝ 用户在用它：标记成"用户接手"，后台采集结束不得自动关
  if (opts.source === 'renderer') pageLeases.claimByUser(storeId)
  // display:false = 只把店铺"打开"（建 session/标签、放行排队任务），**不把它显示出来**。
  // ⚠ 只给"不需要用户看着"的调用方用：渲染层会把它的 webview 留着但隐藏（DOM overlay 只
  // 影响可见性，不再摘除页面），需要真实点击的自动化（采集任务/邀约）应当显示店铺，
  // 否则用户看不到点击落在哪，页面被平台因"不可见"而停摆时也无从判断。
  if (opts.display === false) {
    scheduleStoreReap(storeId)
    return
  }
  displayStore(storeId, opts.source === 'renderer' ? 'renderer' : 'main')
}

/**
 * 切换当前显示店铺。DOM <webview> 的可见性由 Renderer 依据这些状态控制，
 * 主进程不再把 guest 挂到 BrowserWindow.contentView。
 */
export function displayStore(storeId: string | null, source: 'renderer' | 'main' = 'main'): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  if (storeId === null) {
    displayedStoreId = null
    for (const id of browserStates.keys()) applyStoreBackgroundThrottling(id)
    emit(EVENT_CHANNELS.BROWSER_DISPLAY_CHANGED, { storeId: null, source })
    scheduleAllStoreReaps()
    return
  }
  if (!browserStates.has(storeId)) {
    openStoreBrowser(storeId, { display: true, source })
    return
  }
  // 先记住旧店铺，再切换目标；目标打开/状态更新失败时，调用方仍保留原来的显示店铺。
  displayedStoreId = storeId
  // 页面被显示出来了（用户切过去/界面打开/主进程为可交互任务打开）：它归用户。
  // 后台采集借用的页面一旦被显示过，采集结束后就不再自动关闭——否则用户正看着的页面会凭空消失。
  pageLeases.claimByUser(storeId)
  storeLifecycle.used(storeId, 'displayed')
  const state = browserStates.get(storeId)!
  if (!state.activeTabId) {
    const first = Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)[0]
    if (first) state.activeTabId = first.id
  }
  updateStoreLastActive(storeId)
  for (const id of browserStates.keys()) applyStoreBackgroundThrottling(id)
  emitTabs(storeId)
  emit(EVENT_CHANNELS.BROWSER_DISPLAY_CHANGED, { storeId, source })
  scheduleAllStoreReaps()
}

/** 应用锁期间由 Renderer 隐藏 webview，主进程仍禁止任务/Agent 操作。 */
let viewsHiddenForLock = false
export function setBrowserViewsVisible(visible: boolean): void {
  viewsHiddenForLock = !visible
  logMain('info', `店铺 DOM webview ${visible ? '恢复可见性' : '进入锁定隐藏状态'}`)
}

/** DOM overlay 不再需要摘除原生 View；保留状态字段供兼容调用方与诊断。 */
let viewsHiddenForOverlay = false
let viewsHiddenForAgent = false
export type BrowserViewObscuredReason = 'modal' | 'agent'
export function setBrowserViewsObscured(obscured: boolean, reason: BrowserViewObscuredReason = 'modal'): void {
  if (reason === 'agent') viewsHiddenForAgent = obscured
  else viewsHiddenForOverlay = obscured
  logMain('info', `DOM 店铺 webview overlay=${obscured ? 'open' : 'closed'} reason=${reason}`)
}

/**
 * 页面内可见区域的**近似**尺寸（DIP），只用于日志/诊断。
 * DOM <webview> 后主进程看不到真实元素尺寸，需要精确尺寸的场景一律以页面自己的
 * `window.innerWidth/innerHeight` 为准（任务引擎的落点判定就是这么做的）。
 */
function effectiveViewport(): ViewportBounds {
  let bounds = viewport
  if (bounds.width < 50 || bounds.height < 50) {
    try {
      const cb = hostWindow?.getContentBounds()
      if (cb) bounds = { x: 0, y: 0, width: cb.width, height: cb.height }
    } catch { /* keep the last renderer-reported bounds */ }
  }
  return bounds
}

/**
 * 关闭店铺浏览器：销毁其全部标签页 view（数据保留在 DB 供恢复）
 */
export function closeStoreBrowser(storeId: string): void {
  clearStoreReapTimer(storeId)
  storeLifecycle.forget(storeId)
  storeLifecycleBlocks.delete(storeId)
  // 独立窗口不在 browserStates 里，必须显式销毁：否则会出现"店铺已删、独立窗口还放着那家店的页面"，
  // 彻底删除时还会连带清掉这个窗口正在使用的 partition
  for (const win of standaloneWindows.get(storeId) || []) {
    try { if (!win.isDestroyed()) win.destroy() } catch { /* ignore */ }
  }
  standaloneWindows.delete(storeId)

  taskAwakeStores.delete(storeId)
  collectionTabs.delete(storeId)
  pageLeases.forget(storeId)
  const state = browserStates.get(storeId)
  if (!state) return

  saveTabs(storeId)
  state.tabs.forEach(tab => {
    detachGuestWebContents(tab)
    // tabReloadGuard 只在 closeTab 里清过；关店铺这条路径漏了 → 长期开关店铺 + 偶发页面崩溃
    // 会让这个 Map 只增不减（tabId 是随机串，等于慢性泄漏，2026-09-28 审查确认）
    tabReloadGuard.delete(tab.id)
    inPageSaveAt.delete(tab.id)
  })
  browserStates.delete(storeId)

  if (displayedStoreId === storeId) {
    displayedStoreId = null
    const next = Array.from(browserStates.keys())[0]
    if (next) displayStore(next)
  }

  const loginTimer = loginDetectionTimers.get(storeId)
  if (loginTimer) {
    clearTimeout(loginTimer)
    loginDetectionTimers.delete(storeId)
  }
  // 注意：不删除 tabs 行 —— 店铺下次打开/应用重启时按 §4.3 恢复
  // 关掉窗口不代表登录失效（Cookie 仍在分区里），所以这里不写状态：
  // 关一次窗口就把"已确认登录/需要登录"的结论抹成 offline，界面会显示成"登录没了"。
  emitTabs(storeId)
  scheduleAllStoreReaps()
}

/**
 * 后台采集**借用**店铺页面（2026-10-02 用户要求「采集任务完成后关闭网页，优化占用」）。
 *
 * 无人值守的采集（经营数据每 10 分钟、发票每 3 小时）为了拿到页面句柄会自己把店铺浏览器
 * 后台开起来（`display:false`，不抢用户当前页）。以前没人关它 —— 一轮轮下来每个店铺都留下
 * 一个常驻渲染进程。这里把"开"和"关"配成一对：
 *
 *   · 借用时：页面本来没开才开（不抢当前页），并记下"这个页面是后台任务开的"；
 *   · 归还时：只有"我们开的 + 没有别的借用者 + 用户期间没接手过"才真的关掉。
 *
 * 判据全部在 `page-lease.ts`（纯状态机，单测逐条钉住）。用户自己开着/看过一眼的页面
 * 不会被这次采集归还顺手关闭；店铺级冷休眠仍会在独立的空闲策略下回收非当前页面。
 *
 * 用法：`const release = borrowStorePage(storeId); try { ...采集... } finally { release() }`
 */
export function borrowStorePage(storeId: string): () => void {
  const openedByUs = !browserStates.has(storeId)
  if (openedByUs) openStoreBrowser(storeId, { display: false, source: 'main' })
  pageLeases.borrow(storeId, openedByUs)
  storeLifecycle.used(storeId, 'background')
  scheduleAllStoreReaps()
  let released = false
  return () => {
    if (released) return
    released = true
    if (!pageLeases.release(storeId)) return
    // 正在前台显示 = 用户看着它（正常路径下 displayStore 已经标成用户接手，这里再挡一道时序缝隙）
    if (displayedStoreId === storeId) { pageLeases.claimByUser(storeId); return }
    if (!browserStates.has(storeId)) return
    // 租约归还本身只说明“这次采集不用页面了”，不能绕过店铺级生命周期门禁。
    // 例如下载、上传、人工确认或另一个主进程服务仍在使用该店铺时，直接 closeStoreBrowser
    // 会把正在使用的 guest 一并关掉。门禁解除后由各自的回调重新调度冷休眠。
    if (isStoreLifecycleBlocked(storeId)) {
      scheduleAllStoreReaps()
      return
    }
    try {
      closeStoreBrowser(storeId)
      logMain('info', `[browser] 后台采集结束，已关闭借用的店铺页面 store=${storeId}`)
    } catch (error) {
      // 关不掉不是采集的错：如实留日志，不把异常抛回采集流程
      logMain('warn', `[browser] 关闭借用的店铺页面失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
    scheduleAllStoreReaps()
  }
}

/** 借用/接手状态快照：内存诊断据此说明"页面为什么还开着"。 */
export function getStorePageLeaseSnapshot(): ReturnType<StorePageLeases['snapshot']> {
  return pageLeases.snapshot()
}

/** 采集专用标签页：storeId → tabId。它不占活动位、不落库、不进标签栏，只服务采集。 */
const collectionTabs = new Map<string, string>()

/** 取当前有效的采集专用标签页 id（已被关掉/店铺已关则返回 null）。 */
export function getCollectionTabId(storeId: string): string | null {
  const tabId = collectionTabs.get(storeId)
  if (!tabId) return null
  const state = browserStates.get(storeId)
  if (!state || !state.tabs.has(tabId)) { collectionTabs.delete(storeId); return null }
  return tabId
}

/** 取（必要时建）采集专用标签页。**不激活**：用户正在看的页面不会被切走。 */
export function acquireCollectionTab(storeId: string): string {
  const existing = getCollectionTabId(storeId)
  if (existing) return existing
  const tabId = createTab(storeId, 'about:blank', { activate: false, internal: true })
  collectionTabs.set(storeId, tabId)
  return tabId
}

/** 关掉采集专用标签页（采集结束调用；重复调用是空操作）。 */
export function releaseCollectionTab(storeId: string, tabId?: string): void {
  const current = collectionTabs.get(storeId)
  if (!current) return
  if (tabId && tabId !== current) return
  collectionTabs.delete(storeId)
  try { closeTab(storeId, current) } catch { /* 标签页已经不在了 */ }
  scheduleAllStoreReaps()
}

/**
 * 借一个**采集专用**的店铺页面（2026-10-02 用户要求「采集任务时不要影响浏览器使用」）。
 *
 * 与 `borrowStorePage` 的区别：这里给的页面是**独立标签页**，不是用户正在用的那个。
 * 采集的导航、点击、读值全部落在自己的标签页上，用户的标签页（URL、表单、滚动位置）
 * 一点没动；它也不占活动位、不进标签栏（渲染层只挂一个隐藏 webview 给它）。
 *
 * 为什么必须独立标签页：采集会把页面导航到经营数据页、还会点周期控件。以前它直接用
 * "该店铺的活动标签页"，于是每 10 分钟一轮的自动采集会把用户正在填的表单导航走——
 * 用户看到的就是"采集一跑，我的页面就跳了"。
 *
 * 归还（release）：关掉专用标签页；若店铺页面本来就是这次采集开的，再按 `borrowStorePage`
 * 的租约规则决定关不关整个店铺页面（用户自己开着/看过的页面永远不关）。
 *
 * 用法：`const page = borrowCollectionPage(storeId); try { const wc = await page.waitForWebContents(); ... } finally { page.release() }`
 */
export function borrowCollectionPage(storeId: string): {
  waitForWebContents: (timeoutMs?: number) => Promise<Electron.WebContents | null>
  release: () => void
} {
  const releaseBorrowedStore = borrowStorePage(storeId)
  let tabId: string | null = null
  let released = false
  return {
    async waitForWebContents(timeoutMs = 15_000): Promise<Electron.WebContents | null> {
      if (released) return null
      if (!tabId) {
        try { tabId = acquireCollectionTab(storeId) } catch { return null }
      }
      try {
        return await waitForTabWebContents(storeId, tabId, timeoutMs)
      } catch {
        return null
      }
    },
    release(): void {
      if (released) return
      released = true
      if (tabId) {
        releaseCollectionTab(storeId, tabId)
        tabId = null
      }
      releaseBorrowedStore()
    }
  }
}

/**
 * 新建标签页
 *
 * @param opts.activate false = 建完**不**设为活动标签页（采集专用页用它：用户的当前页不被切走）
 * @param opts.internal true = 采集专用页（渲染层挂隐藏 webview，不进标签栏）
 */
export function createTab(storeId: string, url?: string, opts: { activate?: boolean; internal?: boolean } = {}): string {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')

  // 建页入口收敛：非法 scheme 退化为空白页；真正导航由已注册的 DOM guest 执行。
  let safeUrl = 'about:blank'
  if (url) {
    try { safeUrl = assertNavigableUrl(url) } catch { /* 非法地址退化为空白页 */ }
  }
  getSession(storeId)

  const tab: Tab = {
    id: generateTabId(),
    storeId,
    url: safeUrl,
    title: '新标签页',
    isPinned: false,
    orderIndex: state.tabs.size,
    guestAttached: false,
    internal: opts.internal === true
  }
  state.tabs.set(tab.id, tab)

  // 内部页（采集专用）**永不**抢活动位：活动位是用户正在看的那个页面。
  const shouldActivate = opts.activate !== false && opts.internal !== true &&
    (state.activeTabId === null || displayedStoreId === storeId)
  if (shouldActivate) activateTab(storeId, tab.id)
  saveTabToDatabase(tab)
  emitTabs(storeId)
  return tab.id
}

/**
 * 把 Renderer 创建的 DOM <webview> guest 绑定到一个已存在的标签页。
 * 注册前的校验由 IPC handler 负责 sender；这里负责 store/tab/session/重复占用校验。
 */
export async function registerWebview(
  storeId: string,
  tabId: string,
  webContentsId: number
): Promise<{ storeId: string; tabId: string; webContentsId: number; guestAttached: true; pendingUrl: string; url: string }> {
  const state = browserStates.get(storeId)
  const tab = state?.tabs.get(tabId)
  if (!state || !tab) throw new Error('Tab not found')
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) throw new Error('INVALID_ARGUMENT: webContentsId 无效')

  const guest = webContents.fromId(webContentsId)
  if (!guest || guest.isDestroyed()) throw new Error('BROWSER_NOT_READY: webview guest 不存在')
  if (!hostWindow || hostWindow.isDestroyed()) throw new Error('Host window not available')
  try {
    if (guest.hostWebContents !== hostWindow.webContents) {
      throw new Error('IPC_FORBIDDEN: guest 不属于主窗口')
    }
  } catch (err) {
    if (String((err as any)?.message || err).startsWith('IPC_FORBIDDEN')) throw err
    throw new Error('BROWSER_NOT_READY: guest 宿主关系不可验证')
  }
  const expectedSession = getSession(storeId)
  // Electron 为同一个 persist partition 返回同一个 Session 单例；Session 类型本身不暴露
  // partition 字段，因此用实例身份校验，避免把 Renderer 传入的 partition 当成信任边界。
  if (guest.session !== expectedSession) {
    throw new Error('IPC_FORBIDDEN: guest session 与店铺分区不匹配')
  }
  const existing = guestTabs.get(webContentsId)
  if (existing && existing !== tab) throw new Error('IPC_FORBIDDEN: guest 已被其他标签页注册')
  if (tab.webContents && tab.webContents !== guest) {
    if (tab.webContents.isDestroyed()) {
      detachGuestWebContents(tab, false)
    } else {
      // 渲染层重挂（切页回来、渲染层重载）时旧元素可能还没来得及销毁，旧 guest 就成了孤儿：
      // 认新的一定要连带关掉旧的，否则一个标签页留下两个渲染进程，且事件监听会重复触发。
      // 只记一条 warn：这是可恢复的时序，不是安全事件（安全边界由 sender + session 校验承担）。
      logMain('warn', `[webview] 标签页 guest 被重新注册 store=${storeId} tab=${tabId} old=${tab.webContents.id} new=${guest.id}`)
      detachGuestWebContents(tab, true)
    }
  }

  await waitForSessionReady(storeId)
  attachGuestWebContents(tab, guest)
  const currentUrl = guest.getURL() || 'about:blank'
  const pendingUrl = tab.url && tab.url !== 'about:blank' && currentUrl === 'about:blank' ? tab.url : currentUrl
  return {
    storeId,
    tabId,
    webContentsId,
    guestAttached: true,
    pendingUrl,
    url: pendingUrl
  }
}

/** 页面 guest 注册前，等待真实 Electron.WebContents；超时如实返回 BROWSER_NOT_READY。 */
export async function waitForTabWebContents(storeId: string, tabId: string, timeoutMs = 15000): Promise<Electron.WebContents> {
  const tab = browserStates.get(storeId)?.tabs.get(tabId)
  if (!tab) throw new Error('BROWSER_CLOSED: 店铺浏览器或任务标签页已被关闭')
  if (tab.webContents && !tab.webContents.isDestroyed() && tab.guestAttached) return tab.webContents
  const timeout = Math.max(100, Math.min(Number(timeoutMs) || 15000, 120000))
  return await new Promise<Electron.WebContents>((resolve, reject) => {
    const key = tabKey(storeId, tabId)
    const waiters = guestWaiters.get(key) || new Set<(wc: Electron.WebContents | null) => void>()
    const timer = setTimeout(() => {
      waiters.delete(done)
      if (waiters.size === 0) guestWaiters.delete(key)
      reject(new Error(`BROWSER_NOT_READY: 店铺标签页 guest 在 ${timeout}ms 内未注册`))
    }, timeout)
    const done = (wc: Electron.WebContents | null) => {
      clearTimeout(timer)
      waiters.delete(done)
      if (waiters.size === 0) guestWaiters.delete(key)
      if (wc && !wc.isDestroyed()) resolve(wc)
      else reject(new Error('BROWSER_NOT_READY: 店铺标签页 guest 已断开'))
    }
    waiters.add(done)
    guestWaiters.set(key, waiters)
  })
}

/**
 * 采集/登录检测这类"需要页面但没有页面也是一种可解释状态"的入口：
 * 等该店铺活动标签页的 guest 注册完成，超时或店铺没开时如实返回 null。
 *
 * 为什么不直接返回错误：这些服务对外暴露的是 PAGE_NOT_READY 这个**业务状态**
 * （界面显示"请先打开店铺页面"），不是异常；而店铺刚打开时 guest 还在注册路上，
 * 直接判 null 会把"正在打开"误报成"没打开"。
 */
export async function waitForStoreWebContents(storeId: string, timeoutMs = 15000): Promise<Electron.WebContents | null> {
  const immediate = getCurrentStoreWebContents(storeId)
  if (immediate) return immediate
  const state = browserStates.get(storeId)
  const tabId = state?.activeTabId
    || (state ? Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)[0]?.id : undefined)
  if (!state || !tabId) return null
  try {
    return await waitForTabWebContents(storeId, tabId, timeoutMs)
  } catch {
    return null
  }
}

function attachGuestWebContents(tab: Tab, wc: Electron.WebContents): void {
  tab.webContents = wc
  tab.guestWebContentsId = wc.id
  tab.guestAttached = true
  guestTabs.set(wc.id, tab)
  applyBackgroundThrottling(tab)

  wc.setWindowOpenHandler(({ url: targetUrl, disposition }) => {
    // 页面里 target=_blank 的链接、window.open、以及外站"在新标签页打开"都走这里。
    // 关键：**不能把 createTab 的异常吞掉**——吞了以后表现为"点了没反应"，
    // 现场只剩一个空白页，既没有日志也没有提示（2026-09-29 用户实报"浏览器不能打开新标签页"）。
    try {
      const tabId = createTab(tab.storeId, targetUrl)
      logMain('info', `[window-open] 已开新标签页 store=${tab.storeId} tab=${tabId} disposition=${String(disposition)} target=${String(targetUrl).slice(0, 160)}`)
    } catch (error) {
      logMain('warn', `[window-open] 开新标签页失败 store=${tab.storeId} target=${String(targetUrl).slice(0, 160)}: ${String((error as Error)?.message || error).slice(0, 200)}`)
    }
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, targetUrl) => {
    if (isAllowedPageNavigation(targetUrl)) return
    event.preventDefault()
    logMain('warn', `[nav] 页面主动跳转被拦截 store=${tab.storeId} tab=${tab.id} target=${String(targetUrl).slice(0, 200)}`)
  })
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title
    saveTabToDatabase(tab)
    emitTabs(tab.storeId)
  })
  attachStoreContextMenu(wc, () => ({
    wc,
    openUrl: (u) => { try { createTab(tab.storeId, assertNavigableUrl(u)) } catch { /* ignore */ } },
    copyText: (t) => clipboard.writeText(t),
    probeElement: (pt) => { void probeElementAt(wc, pt) },
    openStandalone: () => { try { openStandaloneWindow(tab.storeId, tab.id) } catch { /* ignore */ } }
  }))
  attachStoreReloadShortcuts(wc)
  wc.on('did-navigate', (_e, newUrl) => {
    tab.url = newUrl
    saveTabToDatabase(tab)
    emitTabs(tab.storeId)
    scheduleLoginDetection(tab.storeId)
  })
  wc.on('did-navigate-in-page', (_e, newUrl, isMainFrame) => {
    if (!isMainFrame) return
    tab.url = newUrl
    emitTabs(tab.storeId)
    const last = inPageSaveAt.get(tab.id) || 0
    const now = Date.now()
    if (now - last >= 2000) {
      inPageSaveAt.set(tab.id, now)
      saveTabToDatabase(tab)
    }
    scheduleLoginDetection(tab.storeId)
  })
  wc.on('did-start-loading', () => {
    if (displayedStoreId === tab.storeId) emit(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, { storeId: tab.storeId, tabId: tab.id, isLoading: true })
  })
  wc.on('did-stop-loading', () => {
    if (displayedStoreId === tab.storeId) emit(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, { storeId: tab.storeId, tabId: tab.id, isLoading: false })
    scheduleLoginDetection(tab.storeId)
  })
  wc.on('render-process-gone', (_e, details) => {
    // 主动冷回收/关标签页会先从 Tab 上解绑 guest，再调用 wc.close()。
    // Electron 随后仍可能发出 render-process-gone；这不是页面崩溃，不能让
    // 已经不在 browserStates 的旧 guest 进入自动 reload，否则会重新拉起孤儿
    // renderer，表现为店铺已回收但 WebContents/内存不降反升。
    const currentState = browserStates.get(tab.storeId)
    if (tab.webContents !== wc || currentState?.tabs.get(tab.id) !== tab) return
    logMain('error', `store tab renderer gone store=${tab.storeId} tab=${tab.id} reason=${details.reason} exitCode=${details.exitCode} url=${String(tab.url).slice(0, 120)}`)
    emit(EVENT_CHANNELS.BROWSER_CRASHED, { storeId: tab.storeId, tabId: tab.id, reason: details.reason })
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (now - (tabReloadGuard.get(tab.id) || 0) < TAB_RELOAD_MIN_INTERVAL_MS) {
      logMain('warn', `store tab ${tab.id} 短时间内再次崩溃，跳过自动重载（防重载死循环）`)
      return
    }
    tabReloadGuard.set(tab.id, now)
    try { if (!wc.isDestroyed()) wc.reload() } catch { /* ignore */ }
  })
  wc.on('unresponsive', () => logMain('error', `store tab unresponsive store=${tab.storeId} tab=${tab.id} url=${String(tab.url).slice(0, 120)}`))
  wc.on('responsive', () => logMain('info', `store tab responsive store=${tab.storeId} tab=${tab.id}`))
  wc.once('destroyed', () => {
    if (tab.webContents === wc) detachGuestWebContents(tab, false)
  })
  try { registerFingerprintTarget(tab.storeId, tab.id, wc) } catch { /* ignore */ }
  notifyGuestWaiters(tab)
  saveTabToDatabase(tab)
  emitTabs(tab.storeId)
  scheduleLoginDetection(tab.storeId)
}

const loginDetectionTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 页面完成导航后自动复核登录态；未确认登录的店铺保持 offline。 */
function scheduleLoginDetection(storeId: string, delayMs = 300): void {
  const previous = loginDetectionTimers.get(storeId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    loginDetectionTimers.delete(storeId)
    // 动态导入避免 window-manager ↔ platform-login-service 的模块初始化环。
    void import('../platform-adapters/platform-login-service')
      .then(({ detectStoreLoginStatus }) => detectStoreLoginStatus(storeId))
      .then(result => {
        // 扫码/验证码登录可能只更新当前页面状态而不触发导航；未确认登录时继续
        // 低频复核，直到店铺关闭或检测到 LOGGED_IN。
        if (browserStates.has(storeId) && result.status !== 'LOGGED_IN') scheduleLoginDetection(storeId, 3000)
      })
      .catch(() => { /* 页面未就绪/平台未支持时保持 offline */ })
  }, delayMs)
  loginDetectionTimers.set(storeId, timer)
}

function detachGuestWebContents(tab: Tab, close = true): void {
  const wc = tab.webContents
  if (wc) {
    if (guestTabs.get(wc.id) === tab) guestTabs.delete(wc.id)
    try { unregisterFingerprintTarget(tab.storeId, tab.id) } catch { /* ignore */ }
    tab.webContents = undefined
    tab.guestWebContentsId = undefined
    tab.guestAttached = false
    if (close) {
      try { if (!wc.isDestroyed()) wc.close() } catch { /* ignore */ }
    }
  } else {
    tab.guestAttached = false
  }
  notifyGuestWaiters(tab)
  emitTabs(tab.storeId)
}


/**
 * 激活标签页：只更新"当前活动页"的元数据并发事件。
 * 页面可见性由 Renderer 依据这些状态切换 webview 的显示层级，主进程不再挂/摘原生 View。
 */
export function activateTab(storeId: string, tabId: string): void {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const tab = state.tabs.get(tabId)
  if (!tab) throw new Error('Tab not found')

  state.activeTabId = tabId
  storeLifecycle.used(storeId, displayedStoreId === storeId ? 'displayed' : 'background')
  applyStoreBackgroundThrottling(storeId)
  scheduleStoreReap(storeId)

  const db = getDatabase()
  db.prepare('UPDATE tabs SET last_active_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), tabId)
  emitTabs(storeId)
}

/**
 * 关闭标签页
 */
export function closeTab(storeId: string, tabId: string): void {
  const state = browserStates.get(storeId)
  if (!state) return
  const tab = state.tabs.get(tabId)
  if (!tab) return

  detachGuestWebContents(tab)
  tabReloadGuard.delete(tabId)
  inPageSaveAt.delete(tabId)

  state.tabs.delete(tabId)
  getDatabase().prepare('DELETE FROM tabs WHERE id = ?').run(tabId)
  // 采集专用页被关掉（用户手动关/采集归还）：同步清掉登记，避免拿着死 id 去找页面
  if (collectionTabs.get(storeId) === tabId) collectionTabs.delete(storeId)

  // 重排只改内存会让"重启恢复顺序"错乱：orderIndex 同步落库
  const db = getDatabase()
  const orderStmt = db.prepare('UPDATE tabs SET order_index = ?, updated_at = ? WHERE id = ?')
  let idx = 0
  for (const t of Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)) {
    t.orderIndex = idx
    try { orderStmt.run(idx, Date.now(), t.id) } catch { /* 落库失败不阻塞关闭 */ }
    idx++
  }

  if (state.activeTabId === tabId) {
    state.activeTabId = null
    const next = Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)[0]
    if (next) activateTab(storeId, next.id)
    else if (displayedStoreId === storeId) emitTabs(storeId)
  }
  emitTabs(storeId)
}

/** 固定标签页 */
export function setTabPinned(storeId: string, tabId: string, pinned: boolean): void {
  const state = browserStates.get(storeId)
  if (!state) return
  const tab = state.tabs.get(tabId)
  if (!tab) return
  tab.isPinned = pinned
  getDatabase().prepare('UPDATE tabs SET is_pinned = ?, updated_at = ? WHERE id = ?')
    .run(pinned ? 1 : 0, Date.now(), tabId)
  emitTabs(storeId)
}

/** 标签页重排 */
export function reorderTabs(storeId: string, orderedTabIds: string[]): void {
  const state = browserStates.get(storeId)
  if (!state) return
  const db = getDatabase()
  const stmt = db.prepare('UPDATE tabs SET order_index = ?, updated_at = ? WHERE id = ?')
  // 传入不完整时，未传入的按原顺序排后面——避免 order 重复导致恢复顺序错乱
  const seen = new Set<string>()
  let index = 0
  for (const tabId of orderedTabIds) {
    const tab = state.tabs.get(tabId)
    if (tab && !seen.has(tabId)) {
      seen.add(tabId)
      tab.orderIndex = index
      stmt.run(index, Date.now(), tabId)
      index++
    }
  }
  for (const tab of Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)) {
    if (seen.has(tab.id)) continue
    tab.orderIndex = index
    try { stmt.run(index, Date.now(), tab.id) } catch { /* ignore */ }
    index++
  }
  emitTabs(storeId)
}

/**
 * 页面截图 - §6.2 browser:capture
 */
export async function captureTab(storeId: string, tabId: string, format: string = 'png'): Promise<string> {
  const wc = await waitForTabWebContents(storeId, tabId)
  const deadline = Date.now() + 5000
  while (wc.isLoadingMainFrame() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // DOM <webview> 的可见区域大小由 Renderer 的 CSS 决定，主进程看不到；不带 rect 才是
  // Electron 的"整块可见页面"语义。带上一份窗口级 bounds 会把页面坐标之外的大片空白也截进来。
  let image = await wc.capturePage()
  let png = image.toPNG()
  while ((image.isEmpty() || png.length < 100) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    image = await wc.capturePage()
    png = image.toPNG()
  }
  if (image.isEmpty() || png.length < 100) {
    throw new Error('页面当前不可见，无法截图（CAPTURE_EMPTY：该店铺页面被隐藏或未渲染，请先切到该店铺页面）')
  }
  return format === 'jpeg' ? image.toJPEG(85).toString('base64') : png.toString('base64')
}

/**
 * 标签页导航（§10.1 scheme 白名单：assertNavigableUrl 见 @shared/navigation）
 */
export function navigateTab(storeId: string, tabId: string, url: string): void {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const tab = state.tabs.get(tabId)
  if (!tab) throw new Error('Tab not found')

  const safeUrl = assertNavigableUrl(url)
  tab.url = safeUrl
  saveTabToDatabase(tab)
  emitTabs(storeId)
  if (tab.webContents && !tab.webContents.isDestroyed()) {
    void tab.webContents.loadURL(safeUrl).catch(() => { /* 错误由页面呈现 */ })
  }
}

/**
 * 采集落点元素的定位信息（右键「元素定位信息」）。
 *
 * 做三件事：页面内高亮目标元素（让用户看清选中的是哪一层）、把整理好的锚点写进系统剪贴板
 * （用户直接粘进档案常量文件）、并留一条日志（事后能查"当时采到的原始数据是什么"）。
 *
 * 为什么把结果写**剪贴板 + 日志**而不是弹对话框：
 * ① 弹原生对话框要打断用户，而取锚点往往要连续采好几个元素，一次一弹很烦；
 * ② 剪贴板是"抄进代码"最短的路径；
 * ③ 日志记一条**结构化摘要**（命中/未命中 + 锚点数量）保证"采过"这件事可追溯——
 *    原始 DOM 文本与页面 URL 不进日志（那是把店铺业务数据写进日志文件）。
 */
async function probeElementAt(wc: Electron.WebContents, point: { x: number; y: number }): Promise<void> {
  try {
    const result = await wc.executeJavaScript(buildElementProbeScript(point.x, point.y)) as ElementProbeResult
    const text = formatElementProbe(result)
    if (result.ok) {
      clipboard.writeText(text)
      // 只记结构化摘要：原始结果含页面 DOM 文本与整段 URL，落盘即是把业务数据写进日志
      logMain('info', `[probe] 元素定位信息已采集并写入剪贴板 tab=${wc.id} hit=true tag=${result.tag || ''} anchors=${countProbeAnchors(result)}`)
    } else {
      // 采集失败（落点没元素）不当异常：页面还没加载完、点到空白处都是正常情况，
      // 留痕即可，别打断用户
      logMain('warn', `[probe] 元素定位信息采集未命中 tab=${wc.id} hit=false reason=${result.reason || 'unknown'} point=${point.x},${point.y}`)
    }
  } catch (err) {
    // 注入失败（页面正在导航/崩溃）如实留痕，不抛给 Electron 的事件回调
    logMain('warn', `[probe] 元素定位信息采集失败 tab=${wc.id}: ${String(err)}`)
  }
}

/** 探针可用锚点计数（文案/属性/稳定类名三层），只用于日志摘要 */
function countProbeAnchors(result: ElementProbeResult): number {
  return (result.textAnchor ? 1 : 0)
    + Object.keys(result.attrs || {}).length
    + (result.stableClasses || []).length
}

/**
 * 在店铺页面上启动「拾取元素」，等用户点一下目标元素后返回锚点。
 *
 * 与 probeElementAt（右键采集）的关系：两者共用同一份锚点提取逻辑（element-anchor-js），
 * 保证"右键看到的"和"拾取填进去的"是同一条选择器。区别在触发方式——右键是即取即走，
 * 拾取是编排器里的按钮，走 IPC 把结果送回渲染层直接填进参数框。
 *
 * 调用方（渲染层）负责先切到 picker-mode：编排器贴右保留，原生视图重挂并让出
 * 右侧 560px。这里只做"页面里已经可见"之后的等待，不负责布局。
 */
export async function pickElementFromActiveTab(storeId: string, mode: PickMode): Promise<ElementPickResult> {
  const state = browserStates.get(storeId)
  if (!state) return { ok: false, reason: 'NO_STORE_PAGE' }
  const tab = state.activeTabId ? state.tabs.get(state.activeTabId) : null
  const wc = tab?.webContents
  if (!wc || wc.isDestroyed() || !tab?.guestAttached) return { ok: false, reason: 'BROWSER_NOT_READY' }

  try {
    // 先把键盘焦点交给页面：拾取层挂在页面里，Esc 取消也只监听页面内的 keydown。
    // 视图刚被重新挂上时焦点往往还在主窗口的渲染层上，不主动聚焦的话用户按 Esc
    // 页面上毫无反应，只能干等到 120s 超时——而"以为按了取消、其实没有"是最糟的组合。
    wc.focus()
    // 拾取期间页面导航（用户点了链接/页面自己跳）会让注入的等待层丢失，
    // 主进程侧没有取消通道，只能等 120s 超时。监听导航并在页面里主动 finish，
    // 让拾取立刻返回 PICK_NAVIGATED 而不是干等两分钟。
    const NAVIGATED_RESULT = '__shopilot_pick_navigated__'
    const onNav = () => {
      try {
        void wc.executeJavaScript(
          `(window.${NAVIGATED_RESULT} && window.${NAVIGATED_RESULT}({ ok: false, reason: 'PICK_NAVIGATED' }))`
        ).catch(() => undefined)
      } catch { /* 页面已销毁就等注入 promise 自然失败 */ }
    }
    wc.on('did-start-navigation', onNav)
    try {
      const result = await wc.executeJavaScript(buildElementPickerScript(mode, 120000, NAVIGATED_RESULT)) as ElementPickResult
      logMain('info', `元素拾取 store=${storeId} mode=${mode} :: ${describePickResult(result, mode)}`)
      return result
    } finally {
      wc.removeListener('did-start-navigation', onNav)
    }
  } catch (err) {
    // 注入失败（页面正在导航/崩溃）如实返回原因，不让异常冒到 IPC 层变成 INTERNAL_ERROR
    logMain('warn', `元素拾取失败 store=${storeId} mode=${mode}: ${String(err)}`)
    return { ok: false, reason: 'INJECT_FAILED' }
  } finally {
    // 焦点交还工作台：拾取前把焦点给了页面，回填后用户要立刻在编排器里打字。
    // 渲染层 finally 里也会 window.focus()，这里是主进程侧的双保险。
    try {
      if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.focus()
    } catch { /* ignore */ }
  }
}

/**
 * 给一个店铺页面挂上右键菜单（主窗口标签页与独立窗口共用）。
 *
 * `deps` 传函数而不是对象：动作要用的 wc 与回调都在运行期才确定（标签页会被切换/关闭），
 * 挂载时先不求值更不容易被后续改动引到过期对象上。
 *
 * 与平台自带右键菜单的关系（如实说明，别指望"完全接管"）：
 * 本监听器由浏览器进程在 `context-menu` 事件上回调，**若页面自己 `preventDefault()` 了这个事件，
 * 浏览器就不会走到这里**（Electron/Chromium 的既有行为），此时本菜单不会弹出——
 * 所以「重新加载 / 强制重新加载」在封右键的页面上不可用（工具条上的 ⟳ 与 Ctrl+R 不受影响，仍可用）。
 */
function attachStoreContextMenu(
  wc: Electron.WebContents,
  deps: () => StoreMenuDeps,
  opts?: { isStandalone?: boolean }
): void {
  wc.on('context-menu', (_e, params: StoreContextMenuParams) => {
    // 菜单弹在窗口上：窗口已被销毁时不弹（避免"无主菜单"卡住主进程）
    const win = BrowserWindow.fromWebContents(wc)
    if (!win || win.isDestroyed()) return
    try {
      const input = toStoreMenuInput(params, {
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward()
      }, { isStandalone: opts?.isStandalone })
      const items = buildStoreContextMenu(input)
      // 翻译成 Electron 模板（enabled 契约见 toElectronMenuTemplate 的说明）
      const menu = Menu.buildFromTemplate(toElectronMenuTemplate(items, (id) => {
        try { runStoreMenuAction(id, deps(), { linkUrl: input.linkUrl, probePoint: input.probePoint }) }
        catch (err) { logMain('warn', `store context menu action ${id} failed: ${String(err)}`) }
      }))
      menu.popup({ window: win })
    } catch (err) {
      // 这个回调是 Electron 从浏览器进程同步调起的：异常逃出去会变成主进程 uncaughtException，
      // 表现为"菜单静默不出现"而用户毫无线索。这里兜住并留痕（页面本身不受影响）。
      logMain('error', `store context menu build/popup failed tab=${wc.id}: ${String(err)}`)
    }
  })
}

/**
 * 给店铺页面挂上键盘快捷键：Ctrl+R 重新加载、Ctrl+Shift+R 强制重新加载。
 *
 * 为什么要有这一道（与右键菜单并存）：右键菜单的触发依赖页面**没有**吞掉 `contextmenu`
 * 事件（详见 attachStoreContextMenu 的说明），一旦某个平台页面 `preventDefault()` 了它，
 * 菜单就不会弹，用户就完全没有"重载"的入口了。键盘事件走的是 `before-input-event`，
 * 在页面拿到按键**之前**由主进程处理，不受页面脚本影响，所以它才是那项能力的可靠兜底。
 * （工具条上的 ⟳ 也是兜底之一，但用户点进页面后手在键盘上时这个更顺手。）
 */
function attachStoreReloadShortcuts(wc: Electron.WebContents): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    // 按住不放会连续 keyDown：只认第一次，否则会连着重载（在跑自动化的页面上尤其难受）
    if (input.isAutoRepeat) return
    // 只认 Ctrl+R / Ctrl+Shift+R（macOS 上是 Cmd，语义与浏览器一致）
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return
    // 用 code（物理键位）判断，避免非拉丁键盘布局下 key 不是 'r' 而漏判；
    // code 缺失时退回 key 判断（两者取或，宁可多认也别漏）
    const isR = input.code === 'KeyR' || String(input.key).toLowerCase() === 'r'
    if (!isR) return
    event.preventDefault()
    try {
      if (input.shift) wc.reloadIgnoringCache()
      else wc.reload()
    } catch (err) {
      logMain('warn', `store reload shortcut failed tab=${wc.id}: ${String(err)}`)
    }
  })
}

/**
 * 导航控制（地址栏 前进/后退/重载）
 */
export function tabNavigationControl(storeId: string, tabId: string, action: 'back' | 'forward' | 'reload'): void {
  const state = browserStates.get(storeId)
  const tab = state?.tabs.get(tabId)
  if (!tab) throw new Error('Tab not found')
  const wc = tab.webContents
  if (!wc || wc.isDestroyed() || !tab.guestAttached) throw new Error('BROWSER_NOT_READY: 标签页 guest 尚未注册')
  if (action === 'back' && wc.canGoBack()) wc.goBack()
  if (action === 'forward' && wc.canGoForward()) wc.goForward()
  if (action === 'reload') wc.reload()
}

/** 在独立窗口打开当前页（F-BROWSER-004 / §14 逃生入口） */
export function openStandaloneWindow(storeId: string, tabId?: string): void {
  // 独立窗口继续使用原有 persist:store_<storeId> partition；
  // 这里只通过 Facade 校验店铺并确保底层 Session 已登记，不改变窗口实现。
  getSession(storeId)
  const state = browserStates.get(storeId)
  const tab = tabId ? state?.tabs.get(tabId) : null
  const url = tab?.url && tab.url !== 'about:blank' ? tab.url : undefined

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `ShopPilot - 独立窗口`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 独立窗口默认允许节流；只有可见交互或任务页面需要时再解除。
      backgroundThrottling: true,
      partition: `persist:store_${storeId}`
    }
  })

  // tab.url 建页时已过白名单；window.open 的 targetUrl 来自页面，必须再过一遍
  if (url) {
    try { win.loadURL(assertNavigableUrl(url)).catch(() => { /* 错误由页面呈现 */ }) } catch { /* 非法地址保持空白窗口 */ }
  }
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try { win.loadURL(assertNavigableUrl(targetUrl)).catch(() => { /* 错误由页面呈现 */ }) } catch { /* 非法地址忽略 */ }
    return { action: 'deny' }
  })
  // 独立窗口的页面同样能主动导航：与主窗口标签页同一套白名单
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedPageNavigation(targetUrl)) return
    event.preventDefault()
    logMain('warn', `[nav] 独立窗口页面主动跳转被拦截 store=${storeId} target=${String(targetUrl).slice(0, 200)}`)
  })

  // 独立窗口同样给右键菜单与重载快捷键：导航/重新加载/强制重新加载/编辑/链接/元素定位信息。
  // isStandalone=true → 不出现「在独立窗口打开当前标签页」（已经在这里了）。
  attachStoreContextMenu(win.webContents, () => ({
    wc: win.webContents,
    // 独立窗口没有多标签页，链接就在本窗口打开（与它自己的 window.open 策略一致）；
    // 同样过协议白名单
    openUrl: (u) => { try { win.loadURL(assertNavigableUrl(u)).catch(() => { /* 错误由页面呈现 */ }) } catch { /* ignore */ } },
    copyText: (t) => clipboard.writeText(t),
    probeElement: (pt) => { void probeElementAt(win.webContents, pt) },
    openStandalone: () => { /* 已在独立窗口，无需再用 */ }
  }), { isStandalone: true })
  attachStoreReloadShortcuts(win.webContents)

  // 登记独立窗口：删除/归档店铺时要能一起收敛（closeStoreBrowser 会销毁它们）
  const list = standaloneWindows.get(storeId) || new Set<BrowserWindow>()
  list.add(win)
  standaloneWindows.set(storeId, list)
  win.on('closed', () => {
    const current = standaloneWindows.get(storeId)
    current?.delete(win)
    if (current && current.size === 0) standaloneWindows.delete(storeId)
    scheduleAllStoreReaps()
  })
}

/** 获取店铺标签页（排序后） */
export function getStoreTabs(storeId: string): Tab[] {
  const state = browserStates.get(storeId)
  if (!state) return []
  return Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)
}

/** 该店铺当前打开的独立窗口数量（删除店铺前的收敛自检用） */
export function getStandaloneWindowCount(storeId: string): number {
  return standaloneWindows.get(storeId)?.size || 0
}

/** 任务引擎专用（§4.4）：主进程内受控使用，句柄绝不出主进程 */
export function getTabWebContents(storeId: string, tabId: string): Electron.WebContents | null {
  const tab = browserStates.get(storeId)?.tabs.get(tabId)
  const wc = tab?.webContents
  if (!wc || wc.isDestroyed() || !tab?.guestAttached) return null
  return wc
}

/**
 * 主进程平台登录检测使用当前店铺已打开的页面，不创建 BrowserWindow 或 WebContents。
 * 优先使用活动标签页；没有标签页时兼容该店铺现有的独立 BrowserWindow。
 */
export function getCurrentStoreWebContents(storeId: string): Electron.WebContents | null {
  const state = browserStates.get(storeId)
  const activeTab = state?.activeTabId ? state.tabs.get(state.activeTabId) : null
  const activeContents = activeTab?.webContents
  if (activeContents && !activeContents.isDestroyed() && activeTab?.guestAttached) return activeContents

  for (const win of standaloneWindows.get(storeId) || []) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) return win.webContents
    } catch { /* 忽略正在关闭的独立窗口 */ }
  }
  return null
}

/** Agent 观察只允许读取当前店铺的活动 guest；不接收任意 WebContents。 */
export function isBrowserTabMounted(storeId: string, tabId: string): boolean {
  const tab = browserStates.get(storeId)?.tabs.get(tabId)
  return !!tab?.webContents && tab.guestAttached === true &&
    !tab.webContents.isDestroyed() &&
    displayedStoreId === storeId &&
    browserStates.get(storeId)?.activeTabId === tabId &&
    !viewsHiddenForLock && !viewsHiddenForOverlay && !viewsHiddenForAgent
}

/** Agent drawer 是 DOM overlay，不影响主进程读取当前活动 guest。 */
export function isBrowserTabReadableForAgent(storeId: string, tabId: string): boolean {
  const tab = browserStates.get(storeId)?.tabs.get(tabId)
  return !!tab?.webContents && tab.guestAttached === true &&
    !tab.webContents.isDestroyed() &&
    displayedStoreId === storeId &&
    browserStates.get(storeId)?.activeTabId === tabId &&
    !viewsHiddenForLock
}

export function getActiveTabId(storeId: string): string | null {
  return browserStates.get(storeId)?.activeTabId ?? null
}

/** 任务事件推送通道（供 main/tasks 使用） */
export function emitToRenderer(channel: string, payload: unknown): void {
  emit(channel, payload)
}

/** 店铺浏览器打开监听（供任务引擎唤醒排队 run；单向依赖，避免环） */
const storeOpenListeners: Array<(storeId: string) => void> = []
export function onStoreBrowserOpened(cb: (storeId: string) => void): void {
  storeOpenListeners.push(cb)
}

export function getDisplayedStoreId(): string | null {
  return displayedStoreId
}

export function getOpenStoreIds(): string[] {
  return Array.from(browserStates.keys())
}

/** 只读性能采样：返回主进程、Electron 子进程和店铺页面生命周期摘要。 */
export async function getMemoryDiagnostics(): Promise<{
  capturedAt: number
  main: NodeJS.MemoryUsage
  appMetrics: Array<{ pid: number; type: string; memory: number; cpu: number }>
  stores: Array<{
    storeId: string
    tabs: number
    attachedGuests: number
    taskAwake: boolean
    standaloneWindows: number
    lifecycle: { idleMs: number; warm: boolean; blockedBy: string[] }
  }>
  /** 后台采集借用的页面：谁还开着、是借用中还是用户接手 */
  pageLeases: ReturnType<StorePageLeases['snapshot']>
  /** 仍在下载的店铺，仅用于诊断和回收门禁，不包含文件信息。 */
  activeDownloads: string[]
  totals: { openStores: number; tabs: number; attachedGuests: number; standaloneWindows: number; webContents: number }
}> {
  const storeRows = Array.from(browserStates.entries()).map(([storeId, state]) => ({
    storeId,
    tabs: state.tabs.size,
    attachedGuests: Array.from(state.tabs.values()).filter(tab => !!tab.webContents && !tab.webContents.isDestroyed() && tab.guestAttached).length,
    taskAwake: taskAwakeStores.has(storeId),
    standaloneWindows: standaloneWindows.get(storeId)?.size || 0,
    lifecycle: (() => {
      const record = storeLifecycle.get(storeId)
      return {
        idleMs: record ? Math.max(0, Date.now() - record.lastUsedAt) : 0,
        warm: storeLifecycle.getWarmStoreIds(displayedStoreId, STORE_WARM_CACHE_LIMIT).includes(storeId),
        blockedBy: storeLifecycleBlockReasons(storeId)
      }
    })()
  }))
  const { app } = await import('electron')
  const metrics = app.getAppMetrics().map(metric => ({
    pid: metric.pid,
    type: metric.type,
    memory: metric.memory?.workingSetSize || 0,
    cpu: metric.cpu?.percentCPUUsage || 0
  }))
  const tabs = storeRows.reduce((sum, row) => sum + row.tabs, 0)
  const attachedGuests = storeRows.reduce((sum, row) => sum + row.attachedGuests, 0)
  const standaloneCount = storeRows.reduce((sum, row) => sum + row.standaloneWindows, 0)
  return {
    capturedAt: Date.now(),
    main: process.memoryUsage(),
    appMetrics: metrics,
    stores: storeRows,
    /** 后台采集借用的页面：谁还开着、是借用中还是用户接手（"占用为什么没降下来"看这里） */
    pageLeases: pageLeases.snapshot(),
    activeDownloads: getActiveDownloadStoreIds(),
    totals: { openStores: storeRows.length, tabs, attachedGuests, standaloneWindows: standaloneCount, webContents: webContents.getAllWebContents().length }
  }
}

/**
 * 从数据库恢复标签页（§4.3 重启恢复）
 */
function restoreTabs(storeId: string): void {
  const db = getDatabase()
  const savedTabs = db.prepare(`
    SELECT * FROM tabs WHERE store_id = ? ORDER BY order_index ASC
  `).all(storeId) as any[]

  const state = browserStates.get(storeId)!

  if (savedTabs.length === 0) {
    createTab(storeId, 'about:blank')
    return
  }

  // 恢复会生成新 tabId；先清掉本店铺的旧行，避免每次重开累积翻倍
  db.prepare('DELETE FROM tabs WHERE store_id = ?').run(storeId)

  // 恢复生成的是新 tabId，旧 savedTab.id 已失效：建旧→新映射，
  // 否则 lastActive 用旧 id 查新表永远取不到，重启后活动页恢复退化成第一个。
  const idMap = new Map<string, string>()
  savedTabs.forEach((savedTab: any) => {
    const tabId = createTab(storeId, savedTab.url === 'about:blank' ? undefined : savedTab.url)
    idMap.set(String(savedTab.id), tabId)
    const tab = state.tabs.get(tabId)
    if (tab) {
      tab.isPinned = savedTab.is_pinned === 1
      tab.title = savedTab.title || tab.title
    }
  })

  // 恢复"上次所在的那个标签"：必须取 last_active_at **最大**的那条，而不是"第一条有值的"。
  // 查询是按 order_index 升序返回的，`find(t => t.last_active_at)` 于是会命中 order 最小的
  // 那个曾被点过的标签——用户点过 #2、#3 最后停在 #3，重启却恢复到 #2（2026-09-28 审查确认）。
  const lastActive = savedTabs.reduce((best: any, cur: any) => {
    const curAt = Number(cur?.last_active_at) || 0
    if (!curAt) return best
    const bestAt = Number(best?.last_active_at) || 0
    return curAt > bestAt ? cur : best
  }, null) || savedTabs[0]
  const first = (lastActive && state.tabs.get(idMap.get(String(lastActive.id)) || ''))
    || Array.from(state.tabs.values())[0]
  if (first) {
    state.activeTabId = first.id
    emitTabs(storeId)
  }
}

function saveTabs(storeId: string): void {
  const state = browserStates.get(storeId)
  if (!state) return
  state.tabs.forEach(tab => {
    // 记录实时 URL/标题
    try {
      if (tab.webContents && !tab.webContents.isDestroyed()) {
        tab.url = tab.webContents.getURL() || tab.url
        tab.title = tab.webContents.getTitle() || tab.title
      }
    } catch { /* ignore */ }
    saveTabToDatabase(tab)
  })
}

function saveTabToDatabase(tab: Tab): void {
  // 采集专用页是**临时**的：不落库，否则下次开店/重启会被当成用户的标签页恢复出来
  if (tab.internal === true) return
  const db = getDatabase()
  const now = Date.now()
  const existing = db.prepare('SELECT id FROM tabs WHERE id = ?').get(tab.id)
  if (existing) {
    db.prepare(`
      UPDATE tabs SET url = ?, title = ?, is_pinned = ?, order_index = ?, updated_at = ?
      WHERE id = ?
    `).run(tab.url, tab.title, tab.isPinned ? 1 : 0, tab.orderIndex, now, tab.id)
  } else {
    db.prepare(`
      INSERT INTO tabs (id, store_id, url, title, is_pinned, order_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tab.id, tab.storeId, tab.url, tab.title, tab.isPinned ? 1 : 0, tab.orderIndex, now, now)
  }
}
