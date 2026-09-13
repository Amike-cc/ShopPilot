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

import { BrowserWindow, WebContentsView } from 'electron'
import { getStoreSession } from './session-manager'
import { registerFingerprintTarget, unregisterFingerprintTarget } from './fingerprint-injector'
import { getDatabase } from '../db/database'
import { updateStoreStatus, updateStoreLastActive } from '../stores/store-manager'
import { StoreStatus } from '@shared/enums/store-status'
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
  viewport = bounds
  if (mountedView) {
    mountedView.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(bounds.width, 0), height: Math.max(bounds.height, 0) })
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

  const tabId = generateTabId()
  const session = getStoreSession(storeId)

  const view = new WebContentsView({ webPreferences: { session } })

  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try { createTab(storeId, targetUrl) } catch { /* ignore */ }
    return { action: 'deny' }
  })

  const tab: Tab = {
    id: tabId,
    storeId,
    url: url || 'about:blank',
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
  view.webContents.loadURL(url || 'about:blank').catch(() => { /* 页面错误由视图内呈现 */ })

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

  let idx = 0
  for (const t of Array.from(state.tabs.values()).sort((a, b) => a.orderIndex - b.orderIndex)) {
    t.orderIndex = idx++
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
  orderedTabIds.forEach((tabId, index) => {
    const tab = state.tabs.get(tabId)
    if (tab) {
      tab.orderIndex = index
      stmt.run(index, Date.now(), tabId)
    }
  })
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
 * 标签页导航（§10.1 scheme 白名单）
 */
export function navigateTab(storeId: string, tabId: string, url: string): void {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const tab = state.tabs.get(tabId)
  if (!tab || !tab.webContentsView) throw new Error('Tab not found')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Navigation blocked: invalid URL')
  }

  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error('Navigation blocked: unsafe URL scheme')
  }

  tab.url = url
  tab.webContentsView.webContents.loadURL(url).catch(() => { /* 错误由页面呈现 */ })
  saveTabToDatabase(tab)
  emitTabs(storeId)
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
      partition: `persist:store_${storeId}`
    }
  })

  if (url) win.loadURL(url)
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    win.loadURL(targetUrl)
    return { action: 'deny' }
  })
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

  savedTabs.forEach((savedTab: any) => {
    const tabId = createTab(storeId, savedTab.url === 'about:blank' ? undefined : savedTab.url)
    const tab = state.tabs.get(tabId)
    if (tab) {
      tab.isPinned = savedTab.is_pinned === 1
      tab.title = savedTab.title || tab.title
    }
  })

  const lastActive = savedTabs.find((t: any) => t.last_active_at) || savedTabs[0]
  const first = state.tabs.get(lastActive?.id) || Array.from(state.tabs.values())[0]
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
