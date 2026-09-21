/**
 * 浏览器视图管理器（主窗口内嵌模型）- §4.3 / §8.2
 *
 * 架构：
 * - 主窗口（工作台）是唯一宿主窗口；每个店铺标签页 = 一个 WebContentsView，
 *   挂在主窗口 contentView 上，bounds 对齐渲染层上报的 BrowserViewport 区域。
 * - 同一时刻仅显示 displayStoreId 的活动标签页；切换店铺/标签页 = 换挂载。
 * - 未显示的标签页 WebContents 继续存活（后台加载、状态保留）。
 * - 标签页元数据持久化 tabs 表，重启恢复（§4.3）。
 *
 * 兼容性（M0 实测）：Electron 30 的 View 无 children getter，自跟踪 mountedView；
 * WebContents 无 destroy()，销毁用 webContents.close()。
 */

import { BrowserWindow, Menu, WebContentsView, clipboard } from 'electron'
import { getStoreSession } from './session-manager'
import { registerFingerprintTarget, unregisterFingerprintTarget } from './fingerprint-injector'
import {
  buildStoreContextMenu, runStoreMenuAction, toStoreMenuInput, toElectronMenuTemplate,
  type StoreContextMenuParams, type StoreMenuDeps
} from './store-context-menu'
import { buildElementProbeScript, formatElementProbe, type ElementProbeResult } from './element-probe'
import { buildElementPickerScript, describePickResult, type ElementPickResult, type PickMode } from './element-picker'
import { getDatabase } from '../db/database'
import { updateStoreStatus, updateStoreLastActive } from '../stores/store-manager'
import { StoreStatus } from '@shared/enums/store-status'
import { assertNavigableUrl } from '@shared/navigation'
export { assertNavigableUrl } from '@shared/navigation'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { logMain } from '../services/logger'
import { randomBytes } from 'crypto'

export interface Tab {
  id: string
  storeId: string
  url: string
  title: string
  isPinned: boolean
  orderIndex: number
  webContentsView?: WebContentsView
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

let hostWindow: BrowserWindow | null = null
let mountedView: WebContentsView | null = null
let displayedStoreId: string | null = null
let viewport: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 }

// WebContentsView.setVisible(false) controls compositor visibility, but
// Chromium may keep document.visibilityState="visible" after a view is
// detached. Keep the page lifecycle signal aligned with the native view so
// store pages and acceptance probes observe the same state.
function syncDocumentVisibility(view: WebContentsView, hidden: boolean): void {
  const script = hidden
    ? `(() => {
        try {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        } catch (_) {}
      })()`
    : `(() => {
        try { delete document.visibilityState; } catch (_) {}
        try { delete document.hidden; } catch (_) {}
      })()`
  try {
    if (view.webContents.isDestroyed()) return
    void view.webContents.executeJavaScript(script, true).catch(() => undefined)
  } catch { /* ignore a view destroyed during an overlay transition */ }
}

function generateTabId(): string {
  return `tab_${randomBytes(16).toString('hex')}`
}

/** 标签页崩溃自动重载的节流表（tabId → 上次自动重载时间），防崩溃-重载死循环 */
const TAB_RELOAD_MIN_INTERVAL_MS = 5 * 60 * 1000
const tabReloadGuard = new Map<string, number>()

/** §8.2：注入宿主（主）窗口 */
export function setBrowserHostWindow(win: BrowserWindow): void {
  hostWindow = win
  win.on('closed', () => {
    hostWindow = null
    mountedView = null
    displayedStoreId = null
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
  if (mountedView) {
    mountedView.setBounds({ x: viewport.x, y: viewport.y, width: Math.max(viewport.width, 0), height: Math.max(viewport.height, 0) })
  }
}

/** 向渲染层推送事件（§7：带 entityId，前端按实体更新） */
function emit(channel: string, payload: any): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.webContents.send(channel, payload)
  }
}

function tabSnapshot(tab: Tab) {
  let loading = false
  try { loading = !!tab.webContentsView && !tab.webContentsView.webContents.isDestroyed() && tab.webContentsView.webContents.isLoading() } catch { /* ignore */ }
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isPinned: tab.isPinned,
    orderIndex: tab.orderIndex,
    loading
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
export function openStoreBrowser(storeId: string): void {
  if (!hostWindow || hostWindow.isDestroyed()) {
    throw new Error('Host window not available')
  }

  if (!browserStates.has(storeId)) {
    const state: BrowserState = { tabs: new Map(), activeTabId: null }
    browserStates.set(storeId, state)
    restoreTabs(storeId)
    updateStoreStatus(storeId, StoreStatus.ONLINE)
    // 唤醒等待该店铺的排队任务 run（§4.4：不静默拉起，但已拉起后要放行队列）
    queueMicrotask(() => storeOpenListeners.forEach(cb => { try { cb(storeId) } catch { /* ignore */ } }))
  }
  updateStoreLastActive(storeId)
  displayStore(storeId)
}

/**
 * 切换显示的店铺（§8.2 切换店铺）
 */
export function displayStore(storeId: string | null): void {
  if (!hostWindow || hostWindow.isDestroyed()) return

  if (storeId === null) {
    detachMounted()
    displayedStoreId = null
    return
  }

  if (!browserStates.has(storeId)) {
    openStoreBrowser(storeId)
    return
  }

  displayedStoreId = storeId
  const state = browserStates.get(storeId)!
  const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
  mountTab(active ?? Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)[0] ?? null)
  updateStoreLastActive(storeId)
  emitTabs(storeId)
}

function detachMounted(): void {
  if (mountedView && hostWindow && !hostWindow.isDestroyed()) {
    // removeChildView alone does not make the WebContents invisible. Chromium
    // may keep reporting visibilityState=visible and the native layer can
    // still win the compositor race against HTML modals/context menus.
    try { mountedView.setVisible(false) } catch { /* ignore */ }
    syncDocumentVisibility(mountedView, true)
    try { hostWindow.contentView.removeChildView(mountedView) } catch { /* ignore */ }
  }
  mountedView = null
}

/** 应用锁：渲染层 overlay 无法覆盖 WebContentsView，锁定期间必须摘除挂载 */
let viewsHiddenForLock = false
export function setBrowserViewsVisible(visible: boolean): void {
  viewsHiddenForLock = !visible
  if (!visible) {
    detachMounted()
    return
  }
  if (displayedStoreId) displayStore(displayedStoreId)
}

/**
 * 渲染层弹层（回收站抽屉 / 新建店铺 / 任务对话框）遮挡：WebContentsView 是原生层，
 * 永远画在 HTML 之上，弹层若落在视口区域内会被整块盖住（实测遮挡比例 100%）。
 * 因此弹层打开期间摘除挂载，关闭后若未锁定则重新挂载。
 */
let viewsHiddenForOverlay = false
export function setBrowserViewsObscured(obscured: boolean): void {
  viewsHiddenForOverlay = obscured
  if (obscured) {
    detachMounted()
    logMain('info', '弹层打开：已摘除店铺视图挂载（避免原生层遮挡弹窗）')
    return
  }
  if (viewsHiddenForLock) return
  if (displayedStoreId) {
    // Renderer reloads can leave the main-process overlay flag stale. Restore
    // the current tab silently so the fresh renderer does not receive a
    // synthetic tab-updated event and mistake the store for user-opened state.
    const state = browserStates.get(displayedStoreId)
    const active = state?.activeTabId ? state.tabs.get(state.activeTabId) : null
    mountTab(active ?? (state ? Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)[0] : null) ?? null)
  }
  logMain('info', '弹层关闭：已恢复店铺视图挂载')
}

function mountTab(tab: Tab | null): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  if (viewsHiddenForLock || viewsHiddenForOverlay) { detachMounted(); return }

  if (!tab || !tab.webContentsView) {
    detachMounted()
    return
  }
  // 渲染层从未上报过视口（直启恢复 / 窗口被遮挡时 ResizeObserver 暂停）时 viewport 可能还是 0，
  // 0×0 视图会让页面布局塌缩、受信任点击全部落空（任务引擎实测踩过）。此时退化为整个内容区，
  // 之后渲染层一旦上报真实 bounds（setViewportBounds）即自动纠正。
  let bounds = viewport
  if (bounds.width < 50 || bounds.height < 50) {
    try {
      const cb = hostWindow.getContentBounds()
      bounds = { x: 0, y: 0, width: cb.width, height: cb.height }
    } catch { /* keep viewport */ }
  }
  if (mountedView !== tab.webContentsView) {
    detachMounted()
    hostWindow.contentView.addChildView(tab.webContentsView)
  }
  syncDocumentVisibility(tab.webContentsView, false)
  try { tab.webContentsView.setVisible(true) } catch { /* ignore */ }
  tab.webContentsView.setBounds({
    x: bounds.x, y: bounds.y,
    width: Math.max(bounds.width, 0), height: Math.max(bounds.height, 0)
  })
  mountedView = tab.webContentsView
  // Chromium updates document.visibilityState and its layout one compositor
  // tick after a View is reattached. Re-assert visibility/bounds on that tick.
  setTimeout(() => {
    if (mountedView !== tab.webContentsView || tab.webContentsView.webContents.isDestroyed()) return
    try { tab.webContentsView.setVisible(true) } catch { /* ignore */ }
    tab.webContentsView.setBounds({
      x: bounds.x, y: bounds.y,
      width: Math.max(bounds.width, 0), height: Math.max(bounds.height, 0)
    })
  }, 0)
}

/**
 * 关闭店铺浏览器：销毁其全部标签页 view（数据保留在 DB 供恢复）
 */
export function closeStoreBrowser(storeId: string): void {
  const state = browserStates.get(storeId)
  if (!state) return

  saveTabs(storeId)
  state.tabs.forEach(tab => {
    if (mountedView === tab.webContentsView) detachMounted()
    try { unregisterFingerprintTarget(storeId, tab.id) } catch { /* ignore */ }
    try {
      if (tab.webContentsView && !tab.webContentsView.webContents.isDestroyed()) {
        tab.webContentsView.webContents.close()
      }
    } catch { /* ignore */ }
  })
  browserStates.delete(storeId)

  if (displayedStoreId === storeId) {
    displayedStoreId = null
    const next = Array.from(browserStates.keys())[0]
    if (next) displayStore(next)
  }

  // 注意：不删除 tabs 行 —— 店铺下次打开/应用重启时按 §4.3 恢复
  updateStoreStatus(storeId, StoreStatus.OFFLINE)
  emitTabs(storeId)
}

/**
 * 新建标签页
 */
export function createTab(storeId: string, url?: string): string {
  const state = browserStates.get(storeId)
  if (!state) {
    throw new Error('Browser not open for this store')
  }

  // 建页入口收敛：IPC 参数 / window.open / DB 恢复的老 URL 都经此兜底，
  // 非法 scheme 退化为空白页而非抛错中断（恢复路径抛错会让整个店铺打不开；
  // 需要报错的调用点自己先调 assertNavigableUrl）。
  let safeUrl = 'about:blank'
  if (url) {
    try { safeUrl = assertNavigableUrl(url) } catch { /* 非法地址退化为空白页 */ }
  }

  const tabId = generateTabId()
  const session = getStoreSession(storeId)

  /**
   * backgroundThrottling: false —— **必须关**。
   *
   * Chromium 默认在页面不可见/窗口被遮挡时把 requestAnimationFrame 与定时器降频
   * （后台标签页 rAF 直接停摆）。这对"人在前台看着"的普通浏览没影响，但这家软件的核心
   * 是**无人值守地跑页面自动化**：用户切到别的窗口时，被节流的页面会以各种古怪方式失灵——
   * 实测（2026-09-15 快手达人邀约）：店铺窗口被终端窗口遮住后，页面 `visibilityState=hidden`、
   * rAF 触发 0 次，而快手的「带货类目」级联弹层正是靠 rAF 计算定位，于是弹层永远停在初始的
   * `-9999,-9999`，子类「纸品湿巾」整块在视口外 → 点击步骤如实报「被 unknown 遮挡」，
   * 整轮在类目筛选就失败。把窗口切到前台（rAF 恢复）同一套步骤立刻跑通。
   * 所以：**页面被遮挡是我们不能接受的运行前提**，这里显式关掉节流。
   */
  const view = new WebContentsView({ webPreferences: { session, backgroundThrottling: false } })

  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try { createTab(storeId, targetUrl) } catch { /* ignore */ }
    return { action: 'deny' }
  })

  const tab: Tab = {
    id: tabId,
    storeId,
    url: safeUrl,
    title: '新标签页',
    isPinned: false,
    orderIndex: state.tabs.size,
    webContentsView: view
  }

  view.webContents.on('page-title-updated', (_e, title) => {
    tab.title = title
    saveTabToDatabase(tab)
    emitTabs(storeId)
  })

  // 右键菜单：导航 / 重新加载 / 强制重新加载 / 编辑 / 链接 / 元素定位信息（原生菜单，见 store-context-menu.ts）
  attachStoreContextMenu(view.webContents, () => ({
    wc: view.webContents,
    // 链接地址来自页面（可能是 javascript: 之类），过一遍协议白名单再开
    openUrl: (u) => { try { createTab(storeId, assertNavigableUrl(u)) } catch { /* ignore */ } },
    copyText: (t) => clipboard.writeText(t),
    probeElement: (pt) => { void probeElementAt(view.webContents, pt) },
    openStandalone: () => { try { openStandaloneWindow(storeId, tabId) } catch { /* ignore */ } }
  }))
  // 键盘兜底：页面即使封了右键，Ctrl+R / Ctrl+Shift+R 仍然可用
  attachStoreReloadShortcuts(view.webContents)

  view.webContents.on('did-navigate', (_e, newUrl) => {
    tab.url = newUrl
    saveTabToDatabase(tab)
    emitTabs(storeId)
  })

  view.webContents.on('did-start-loading', () => {
    if (displayedStoreId === storeId) emit(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, { storeId, tabId, isLoading: true })
  })
  view.webContents.on('did-stop-loading', () => {
    if (displayedStoreId === storeId) emit(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, { storeId, tabId, isLoading: false })
  })

  // 渲染进程崩溃：留痕（此前只发了个 toast，日志里查不到，无法事后定位）+ 有界自动重载。
  // 同一标签页 5 分钟内最多自动重载一次，避免"崩溃-重载"死循环把 CPU 打满。
  view.webContents.on('render-process-gone', (_e, details) => {
    logMain('error', `store tab renderer gone store=${storeId} tab=${tabId} reason=${details.reason} exitCode=${details.exitCode} url=${String(tab.url).slice(0, 120)}`)
    emit(EVENT_CHANNELS.BROWSER_CRASHED, { storeId, tabId, reason: details.reason })
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (now - (tabReloadGuard.get(tabId) || 0) < TAB_RELOAD_MIN_INTERVAL_MS) {
      logMain('warn', `store tab ${tabId} 短时间内再次崩溃，跳过自动重载（防重载死循环）`)
      return
    }
    tabReloadGuard.set(tabId, now)
    logMain('warn', `store tab ${tabId} 自动重载恢复`)
    try { view.webContents.reload() } catch { /* ignore */ }
  })

  // 无响应（"卡死"）留痕：店铺页面卡住时用户只看到转圈，日志必须留下证据
  view.webContents.on('unresponsive', () => {
    logMain('error', `store tab unresponsive store=${storeId} tab=${tabId} url=${String(tab.url).slice(0, 120)}`)
  })
  view.webContents.on('responsive', () => {
    logMain('info', `store tab responsive store=${storeId} tab=${tabId}`)
  })

  state.tabs.set(tabId, tab)

  // 环境指纹注入（UA-CH/时区/navigator/screen/WebGL）——须在首次导航前注册
  try { registerFingerprintTarget(storeId, tabId, view.webContents) } catch { /* ignore */ }

  const shouldActivate = state.activeTabId === null || displayedStoreId === storeId
  if (shouldActivate) {
    activateTab(storeId, tabId)
  }

  // 始终显式加载（含 about:blank）：确保文档提交、dom-ready 触发、executeJavaScript 可解析
  view.webContents.loadURL(safeUrl).catch(() => { /* 页面错误由视图内呈现 */ })

  saveTabToDatabase(tab)
  emitTabs(storeId)
  return tabId
}

/**
 * 激活标签页（若该店铺正在显示则换挂载）
 */
export function activateTab(storeId: string, tabId: string): void {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const tab = state.tabs.get(tabId)
  if (!tab) throw new Error('Tab not found')

  state.activeTabId = tabId

  if (displayedStoreId === storeId) {
    mountTab(tab)
  }

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

  if (mountedView === tab.webContentsView) detachMounted()
  try { unregisterFingerprintTarget(storeId, tabId) } catch { /* ignore */ }
  tabReloadGuard.delete(tabId)
  try {
    if (tab.webContentsView && !tab.webContentsView.webContents.isDestroyed()) {
      tab.webContentsView.webContents.close()
    }
  } catch { /* ignore */ }

  state.tabs.delete(tabId)
  getDatabase().prepare('DELETE FROM tabs WHERE id = ?').run(tabId)

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
    else if (displayedStoreId === storeId) mountTab(null)
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
  const state = browserStates.get(storeId)
  const tab = state?.tabs.get(tabId)
  if (!tab || !tab.webContentsView) throw new Error('Tab not found')

  // A resize or overlay transition can briefly leave the native view detached/zero-sized.
  // Reattach the displayed tab and retry until Chromium has a non-empty frame instead of
  // returning a successful but unusable zero-byte screenshot.
  if (displayedStoreId === storeId && !viewsHiddenForLock && !viewsHiddenForOverlay) {
    mountTab(tab)
  }
  const deadline = Date.now() + 5000
  while (tab.webContentsView.webContents.isLoadingMainFrame() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const captureRect = {
    x: 0, y: 0,
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height))
  }
  let image = await tab.webContentsView.webContents.capturePage(captureRect)
  let png = image.toPNG()
  while ((image.isEmpty() || png.length < 100) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (displayedStoreId === storeId && !viewsHiddenForLock && !viewsHiddenForOverlay) mountTab(tab)
    image = await tab.webContentsView.webContents.capturePage(captureRect)
    png = image.toPNG()
  }
  if (image.isEmpty() || png.length < 100) throw new Error('页面当前不可见，无法截图')
  return format === 'jpeg' ? image.toJPEG(85).toString('base64') : png.toString('base64')
}

/**
 * 标签页导航（§10.1 scheme 白名单：assertNavigableUrl 见 @shared/navigation）
 */
export function navigateTab(storeId: string, tabId: string, url: string): void {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const tab = state.tabs.get(tabId)
  if (!tab || !tab.webContentsView) throw new Error('Tab not found')

  const safeUrl = assertNavigableUrl(url)

  tab.url = safeUrl
  tab.webContentsView.webContents.loadURL(safeUrl).catch(() => { /* 错误由页面呈现 */ })
  saveTabToDatabase(tab)
  emitTabs(storeId)
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
 * ③ 日志保证剪贴板被覆盖后仍可追溯（写的是完整原始数据，剪贴板里是排版后的可读文本）。
 */
async function probeElementAt(wc: Electron.WebContents, point: { x: number; y: number }): Promise<void> {
  try {
    const result = await wc.executeJavaScript(buildElementProbeScript(point.x, point.y)) as ElementProbeResult
    const text = formatElementProbe(result)
    if (result.ok) {
      clipboard.writeText(text)
      logMain('info', `元素定位信息已采集并写入剪贴板 tab=${wc.id} tag=${result.tag} text=${JSON.stringify(result.textAnchor || '')} raw=${JSON.stringify(result)}`)
    } else {
      // 采集失败（落点没元素）不当异常：页面还没加载完、点到空白处都是正常情况，
      // 留痕即可，别打断用户
      logMain('warn', `元素定位信息采集未命中 tab=${wc.id} reason=${result.reason} point=${point.x},${point.y}`)
    }
  } catch (err) {
    // 注入失败（页面正在导航/崩溃）如实留痕，不抛给 Electron 的事件回调
    logMain('warn', `元素定位信息采集失败 tab=${wc.id}: ${String(err)}`)
  }
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
  const wc = tab?.webContentsView?.webContents
  if (!wc) return { ok: false, reason: 'NO_ACTIVE_TAB' }

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
  if (!tab || !tab.webContentsView) throw new Error('Tab not found')
  const wc = tab.webContentsView.webContents
  if (action === 'back' && wc.canGoBack()) wc.goBack()
  if (action === 'forward' && wc.canGoForward()) wc.goForward()
  if (action === 'reload') wc.reload()
}

/** 在独立窗口打开当前页（F-BROWSER-004 / §14 逃生入口） */
export function openStandaloneWindow(storeId: string, tabId?: string): void {
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
      // 同主窗口的店铺标签页：独立窗口同样可能被遮挡，节流会让页面里的 rAF 依赖型组件失灵
      backgroundThrottling: false,
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
}

/** 获取店铺标签页（排序后） */
export function getStoreTabs(storeId: string): Tab[] {
  const state = browserStates.get(storeId)
  if (!state) return []
  return Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)
}

/** 任务引擎专用（§4.4）：主进程内受控使用，句柄绝不出主进程 */
export function getTabWebContents(storeId: string, tabId: string): Electron.WebContents | null {
  const wc = browserStates.get(storeId)?.tabs.get(tabId)?.webContentsView?.webContents
  if (!wc || wc.isDestroyed()) return null
  return wc
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

  const lastActive = savedTabs.find((t: any) => t.last_active_at) || savedTabs[0]
  const first = (lastActive && state.tabs.get(idMap.get(String(lastActive.id)) || ''))
    || Array.from(state.tabs.values())[0]
  if (first) {
    state.activeTabId = first.id
    mountTab(first)
  }
}

function saveTabs(storeId: string): void {
  const state = browserStates.get(storeId)
  if (!state) return
  state.tabs.forEach(tab => {
    // 记录实时 URL/标题
    try {
      if (tab.webContentsView && !tab.webContentsView.webContents.isDestroyed()) {
        tab.url = tab.webContentsView.webContents.getURL() || tab.url
        tab.title = tab.webContentsView.webContents.getTitle() || tab.title
      }
    } catch { /* ignore */ }
    saveTabToDatabase(tab)
  })
}

function saveTabToDatabase(tab: Tab): void {
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
