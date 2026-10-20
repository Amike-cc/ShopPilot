/**
 * 通用后台页：由主进程隐藏窗口承载的业务页面（不占用户标签页）。
 *
 * 为什么需要这一层（2026-10-19 达人邀约「后端运行」落地后抽出的通用能力）：
 *   · 以前后台页面的实现写在 window-browser-core 里，并且直接叫 `inviteWorkerTabs`——
 *     浏览器核心知道了具体业务，新模块要用只能复制；
 *   · 现在按 `purpose` 复用：同一店铺可以同时有多个用途的后台页（邀约、后续的发布/采集），
 *     各自独立创建、独立释放，浏览器核心只负责标签页与会话。
 *
 * 行为不变量（与改造前逐字一致）：
 *   · `show:false`、`skipTaskbar:true`、同一个 `persist:store_<id>` 分区、`backgroundThrottling:false`；
 *   · 登记成 `internal + worker` 标签页：不进标签栏、不抢活动位、不落库、对渲染层不可见；
 *   · `window.open` 不建原生弹窗，而是建同样隐藏的子窗口并登记成同 purpose 的 worker 页；
 *   · 释放时连子页一起销毁；店铺冷休眠把它当作「仍在使用」。
 *
 * 依赖方向：本模块只依赖 browser/window-state、session、指纹与日志，不 import 任何业务模块；
 * `window-browser-core` 反向依赖本模块（清理/生命周期钩子），保持单向。
 */

import { BrowserWindow } from 'electron'
import { assertNavigableUrl } from '@shared/navigation'
import { getSession } from './shop-session-manager'
import { getStorePartition } from './session-manager'
import { registerFingerprintTarget, unregisterFingerprintTarget } from './fingerprint-injector'
import {
  browserStates,
  generateTabId,
  guestTabs,
  isAllowedPageNavigation,
  notifyGuestWaiters,
  storeLifecycle
} from './window-state'
import type { Tab } from './window-state'
import { logMain } from '../services/logger'

export interface BackgroundPageOptions {
  /** 用途：同一店铺可同时存在不同用途的后台页（如 `creator-invite`）。 */
  purpose: string
  width?: number
  height?: number
}

export interface BackgroundPageHandle {
  tabId: string
  webContents: Electron.WebContents
}

/** storeId → purpose → 根标签页 id（子页不登记在这里，随根页一起释放）。 */
const backgroundPages = new Map<string, Map<string, string>>()
/** tabId → 创建时间：诊断用，回答「这个后台页活了多久」。 */
const createdAt = new Map<string, number>()

/** 生命周期钩子：核心模块用它决定「全部后台页关掉后是否回收 browserState」。 */
type BackgroundPageLifecycleHook = (storeId: string) => void
let lifecycleHook: BackgroundPageLifecycleHook | null = null

export function setBackgroundPageLifecycleHook(hook: BackgroundPageLifecycleHook | null): void {
  lifecycleHook = hook
}

function notifyChanged(storeId: string): void {
  try { lifecycleHook?.(storeId) } catch { /* 生命周期钩子失败不影响页面清理 */ }
}

function rootOf(storeId: string, purpose: string): string | null {
  const tabId = backgroundPages.get(storeId)?.get(purpose)
  if (!tabId) return null
  const tab = browserStates.get(storeId)?.tabs.get(tabId)
  if (!tab || tab.worker !== true) {
    backgroundPages.get(storeId)?.delete(purpose)
    return null
  }
  return tabId
}

/** 某用途的根后台页 id（子页由 window.open 产生，不登记在这里）。 */
export function getBackgroundPageTabId(storeId: string, purpose: string): string | null {
  return rootOf(storeId, purpose)
}

/** 这家店是否还有任意后台页（核心用它把店铺判定为「仍在使用」）。 */
export function hasBackgroundPages(storeId: string): boolean {
  const state = browserStates.get(storeId)
  if (!state) return false
  return Array.from(state.tabs.values()).some(tab => tab.worker === true)
}

function webPreferences(storeId: string): Electron.WebPreferences {
  return {
    partition: getStorePartition(storeId),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // 隐藏窗口必须关节流：否则平台弹层依赖的 rAF/定时器会被降到 1fps，点击落点判定会假超时。
    backgroundThrottling: false
  }
}

function createHiddenWindow(storeId: string, opts: BackgroundPageOptions): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: opts.width || 1440,
    height: opts.height || 900,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: webPreferences(storeId)
  })
}

/** 把隐藏窗口的 webContents 登记成一个 worker 标签页（不落库、不广播、不激活）。 */
function registerTab(storeId: string, tabId: string, purpose: string, win: BrowserWindow): Tab {
  const state = browserStates.get(storeId)
  if (!state) throw new Error('Browser not open for this store')
  const wc = win.webContents
  const tab: Tab = {
    id: tabId,
    storeId,
    url: 'about:blank',
    title: '后台页面',
    isPinned: false,
    orderIndex: state.tabs.size,
    guestAttached: true,
    internal: true,
    worker: true,
    purpose,
    workerWindow: win,
    webContents: wc,
    guestWebContentsId: wc.id
  }
  state.tabs.set(tabId, tab)
  createdAt.set(tabId, Date.now())
  guestTabs.set(wc.id, tab)
  try { wc.setBackgroundThrottling(false) } catch { /* 窗口可能正在关闭 */ }
  try { registerFingerprintTarget(storeId, tabId, wc) } catch (error) {
    logMain('warn', `[background-page] 指纹注入注册失败 store=${storeId} tab=${tabId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
  }

  const adoptUrl = (url: string): void => {
    if (!url || url === 'about:blank') return
    tab.url = url
  }
  wc.on('did-navigate', (_event, url) => {
    adoptUrl(url)
    logMain('info', `[background-page] 导航 store=${storeId} tab=${tabId} url=${String(url).slice(0, 160)}`)
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) adoptUrl(url) })
  wc.on('did-fail-load', (_event, errorCode, description, url, isMainFrame) => {
    if (!isMainFrame) return
    logMain('warn', `[background-page] 加载失败 store=${storeId} tab=${tabId} code=${errorCode} ${description} url=${String(url).slice(0, 160)}`)
  })
  wc.on('page-title-updated', (_event, title) => { if (title) tab.title = title })
  wc.on('will-navigate', (event, url) => {
    if (isAllowedPageNavigation(url)) return
    event.preventDefault()
    logMain('warn', `[background-page] 页面主动跳转被拦截 store=${storeId} target=${String(url).slice(0, 200)}`)
  })
  /**
   * 平台「详情」是 window.open 开新页。这里**不交给 Chromium 建原生窗口**，而是自己建一个
   * 同样隐藏的窗口并登记成 worker 标签页：任务引擎的 followTab 才能在 getStoreTabs 里
   * 找到它，且它永远不会在用户桌面弹出来。
   */
  wc.setWindowOpenHandler(({ url }) => {
    try { openChildTab(storeId, purpose, url) } catch (error) {
      logMain('warn', `[background-page] 打开后台子页失败 store=${storeId} purpose=${purpose} target=${String(url).slice(0, 160)}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
    return { action: 'deny' }
  })
  wc.on('destroyed', () => destroyBackgroundPageTab(storeId, tabId, { destroyWindow: false }))
  win.on('closed', () => destroyBackgroundPageTab(storeId, tabId, { destroyWindow: false }))
  return tab
}

/** 单个 (店铺, 用途) 同时存在的后台子页上限：平台页循环弹窗时封顶（每窗一个渲染进程）。 */
const MAX_CHILD_TABS_PER_PURPOSE = 8

function openChildTab(storeId: string, purpose: string, targetUrl: string): string | null {
  if (!browserStates.has(storeId)) return null
  let url = ''
  try { url = assertNavigableUrl(targetUrl) } catch { return null }
  // 平台页面若循环 window.open，不封顶会在一次运行内堆积大量隐藏窗口；releaseBackgroundPages
  // 只在批次终态清理，运行中不受控。超限直接拒绝：任务引擎对 followTab 找不到目标会如实报错。
  const state = browserStates.get(storeId)!
  let purposeCount = 0
  for (const tab of state.tabs.values()) {
    if (tab.worker === true && tab.purpose === purpose) purposeCount++
  }
  if (purposeCount >= MAX_CHILD_TABS_PER_PURPOSE) {
    logMain('warn', `[background-page] 子页数量达上限 purpose=${purpose} count=${purposeCount}，拒绝再开 ${String(targetUrl).slice(0, 120)}`)
    return null
  }
  const tabId = generateTabId()
  const win = createHiddenWindow(storeId, { purpose })
  registerTab(storeId, tabId, purpose, win)
  void win.loadURL(url).then(() => {
    logMain('info', `[background-page] 后台子页已加载 tab=${tabId} url=${String(win.webContents.getURL()).slice(0, 160)}`)
  }).catch((error: Error) => {
    logMain('warn', `[background-page] 后台子页加载失败 tab=${tabId} target=${url.slice(0, 160)}: ${String(error?.message || error).slice(0, 160)}`)
  })
  logMain('info', `[background-page] window.open 已转入后台标签页 store=${storeId} tab=${tabId} purpose=${purpose} target=${url.slice(0, 160)}`)
  return tabId
}

function forgetRoot(storeId: string, tabId: string): void {
  const roots = backgroundPages.get(storeId)
  if (!roots) return
  for (const [purpose, rootId] of Array.from(roots.entries())) {
    if (rootId === tabId) roots.delete(purpose)
  }
  if (roots.size === 0) backgroundPages.delete(storeId)
}

/**
 * 销毁一个后台页记录（幂等）。`destroyWindow:false` 用于窗口已经关闭的回调里，
 * 避免与 close/destroy 互相递归。
 */
export function destroyBackgroundPageTab(storeId: string, tabId: string, opts: { destroyWindow?: boolean } = {}): void {
  const state = browserStates.get(storeId)
  const tab = state?.tabs.get(tabId)
  if (tab) {
    if (tab.webContents && guestTabs.get(tab.webContents.id) === tab) guestTabs.delete(tab.webContents.id)
    try { unregisterFingerprintTarget(storeId, tabId) } catch { /* 已卸载 */ }
    tab.guestAttached = false
    state!.tabs.delete(tabId)
    createdAt.delete(tabId)
    notifyGuestWaiters(tab)
    if (opts.destroyWindow !== false && tab.workerWindow && !tab.workerWindow.isDestroyed()) {
      try { tab.workerWindow.destroy() } catch { /* 窗口已销毁 */ }
    }
  }
  forgetRoot(storeId, tabId)
  notifyChanged(storeId)
}

/** 店铺整体关闭时清掉登记（窗口由 closeStoreBrowser 自己销毁）。 */
export function forgetBackgroundPages(storeId: string): void {
  backgroundPages.delete(storeId)
}

/**
 * 取（必要时创建）后台页。**不显示、不激活、不广播**。
 * 店铺没有打开过也能用：这里只建 browserState + 隐藏窗口，不建用户可见的首页标签。
 */
export function acquireBackgroundPage(storeId: string, options: BackgroundPageOptions): BackgroundPageHandle {
  const purpose = String(options.purpose || '').trim()
  if (!purpose) throw new Error('INVALID_ARGUMENT: 后台页缺少 purpose')
  const existing = rootOf(storeId, purpose)
  if (existing) {
    const wc = browserStates.get(storeId)!.tabs.get(existing)!.webContents
    if (wc && !wc.isDestroyed()) {
      storeLifecycle.used(storeId, 'background')
      return { tabId: existing, webContents: wc }
    }
    destroyBackgroundPageTab(storeId, existing, { destroyWindow: false })
  }

  // getSession 会校验店铺存在/未删除，并确保 persist 分区、代理与 UA 已建立。
  getSession(storeId)
  if (!browserStates.has(storeId)) {
    browserStates.set(storeId, { tabs: new Map(), activeTabId: null })
    storeLifecycle.opened(storeId)
  }
  storeLifecycle.used(storeId, 'background')

  const tabId = generateTabId()
  const win = createHiddenWindow(storeId, options)
  registerTab(storeId, tabId, purpose, win)
  const roots = backgroundPages.get(storeId) || new Map<string, string>()
  roots.set(purpose, tabId)
  backgroundPages.set(storeId, roots)
  notifyChanged(storeId)
  logMain('info', `[background-page] 已就绪 store=${storeId} purpose=${purpose} tab=${tabId}（不占用户窗口、不进标签栏）`)
  return { tabId, webContents: win.webContents }
}

/** 关闭某用途下的全部后台页（含 window.open 产生的子页）；重复调用是空操作。 */
export function releaseBackgroundPages(storeId: string, purpose: string): void {
  const state = browserStates.get(storeId)
  if (!state) {
    backgroundPages.get(storeId)?.delete(purpose)
    return
  }
  const ids = Array.from(state.tabs.values())
    .filter(tab => tab.worker === true && tab.purpose === purpose)
    .map(tab => tab.id)
  for (const tabId of ids) {
    try { destroyBackgroundPageTab(storeId, tabId, { destroyWindow: true }) } catch (error) {
      logMain('warn', `[background-page] 关闭后台页失败 store=${storeId} purpose=${purpose} tab=${tabId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
  }
  backgroundPages.get(storeId)?.delete(purpose)
  notifyChanged(storeId)
}

export interface BackgroundPageSnapshot {
  storeId: string
  purpose: string
  tabId: string
  title: string
  /** 只回 origin + path，不带查询串（诊断不泄漏 token） */
  url: string
  /** 已存活毫秒数 */
  ageMs: number
}

/**
 * 后台页诊断快照（只读）：回答「现在有几个后台页、属于谁、活了多久」。
 * 不返回正文、Cookie 或任何凭据；URL 去掉查询串。
 */
export function getBackgroundPageSnapshots(): BackgroundPageSnapshot[] {
  const out: BackgroundPageSnapshot[] = []
  for (const [storeId, state] of browserStates.entries()) {
    for (const tab of state.tabs.values()) {
      if (tab.worker !== true) continue
      let url = tab.url || ''
      try { const parsed = new URL(url); url = `${parsed.origin}${parsed.pathname}` } catch { /* about:blank 等保持原样 */ }
      out.push({
        storeId,
        purpose: tab.purpose || '',
        tabId: tab.id,
        title: tab.title || '',
        url,
        ageMs: Math.max(0, Date.now() - (createdAt.get(tab.id) || Date.now()))
      })
    }
  }
  return out
}
