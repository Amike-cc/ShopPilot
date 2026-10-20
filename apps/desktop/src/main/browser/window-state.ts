/**
 * 浏览器视图管理器的**进程内状态与共享原语**（2026-10-19 P1 重构：由 window-manager.ts 等价搬迁）。
 *
 * 这里只放：类型、browserStates/guestTabs 等状态表、模块级可变状态的持有者 `S`、
 * 事件广播与各模块都要用的只读查询。上层模块共享同一份绑定，不再各自持有副本。
 */

import { BrowserWindow } from 'electron'
import { StorePageLeases } from './page-lease'
import { assertNavigableUrl } from '@shared/navigation'
import { logMain } from '../services/logger'
import { randomBytes } from 'crypto'
import { DEFAULT_STORE_COLD_SLEEP_AFTER_MS, DEFAULT_STORE_WARM_CACHE_LIMIT, StoreLifecycleRegistry } from './store-lifecycle'

/**
 * 临时原生快捷键诊断：只有本次验收启动 Electron 时显式设置
 * SHOPILOT_INPUT_DIAGNOSTICS=1 才落主进程日志，默认不增加生产日志量。
 */
const INPUT_DIAGNOSTICS = process.env.SHOPILOT_INPUT_DIAGNOSTICS === '1'

export function logInputDiagnostic(message: string): void {
  if (INPUT_DIAGNOSTICS) logMain('info', `[input-diagnostic] ${message}`)
}

export function describeBeforeInput(input: Electron.Input): string {
  const modifiers = Array.isArray(input.modifiers) ? input.modifiers.join(',') : ''
  return JSON.stringify({
    type: input.type,
    key: input.key,
    code: input.code,
    modifiers,
    control: input.control,
    shift: input.shift,
    alt: input.alt,
    meta: input.meta,
    isAutoRepeat: input.isAutoRepeat
  })
}

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
  /**
   * 后台工作页（达人邀约专用）：由主进程自己的**隐藏 BrowserWindow** 承载，
   * 不依赖渲染层挂 `<webview>`、不进标签栏、不抢活动位，也不会让主界面切到店铺浏览器。
   *
   * 与 internal（采集专用页）的区别：internal 仍要渲染层挂隐藏 webview 才有页面；
   * worker 页在用户完全没打开店铺、甚至没打开工作台浏览器时也能跑。
   */
  worker?: boolean
  /** 后台工作页的用途（worker=true 时存在）：同一店铺可并存多个用途的后台页。 */
  purpose?: string
  /** 后台工作页对应的隐藏窗口（worker=true 时存在）；关闭标签页时一并销毁。 */
  workerWindow?: Electron.BrowserWindow
  /** Renderer DOM <webview> 注册后的 guest 句柄；不向 Renderer 暴露。 */
  webContents?: Electron.WebContents
  guestWebContentsId?: number
  guestAttached?: boolean
}

export interface BrowserState {
  tabs: Map<string, Tab>
  activeTabId: string | null
}

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export const browserStates = new Map<string, BrowserState>()

/** 店铺的「独立窗口」逃生入口：不随 browserStates 走，删除店铺时要显式销毁 */
export const standaloneWindows = new Map<string, Set<BrowserWindow>>()


/** guest id -> 已绑定的店铺标签页，防止一个 guest 被重复认领。 */
export const guestTabs = new Map<number, Tab>()
/** 注册完成前等待页面句柄的任务/页面工具。 */
export const guestWaiters = new Map<string, Set<(wc: Electron.WebContents | null) => void>>()
/**
 * DOM `<webview>` 被 Vue 卸载后，guest 通常会自行销毁。切店/关标签时如果在同一个
 * 主进程 tick 里直接调用 `webContents.close()`，宿主 Renderer 仍可能持有旧元素，
 * Electron 44 会在 guest detach 与 DOM teardown 交错时崩掉渲染进程。先解绑状态并
 * 给宿主一个渲染机会，再兜底关闭仍未销毁的 guest，避免进程泄漏。
 */
export const pendingGuestCloseTimers = new Map<number, ReturnType<typeof setTimeout>>()
/** 任务执行期间即使页面未显示也必须保持活动；任务结束后恢复后台节流。 */
export const taskAwakeStores = new Set<string>()
/** 后台采集借用店铺页面的租约账本：采集结束按需关页面（见 page-lease.ts）。 */
export const pageLeases = new StorePageLeases()

/**
 * 店铺级生命周期：当前店铺保持可交互，最近一次切换的上一家作为温缓存，
 * 其它店铺空闲达到阈值后冷休眠（关闭 guest/WebContents，Session 与标签页记录保留）。
 */
export const storeLifecycle = new StoreLifecycleRegistry()
export const storeReapTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 店铺级生命周期门禁按 reason 计数；同一原因可被多个并发服务持有。 */
export const storeLifecycleBlocks = new Map<string, Map<StoreLifecycleBlockReason, number>>()
export const STORE_WARM_CACHE_LIMIT = DEFAULT_STORE_WARM_CACHE_LIMIT
export const STORE_COLD_SLEEP_AFTER_MS = DEFAULT_STORE_COLD_SLEEP_AFTER_MS
export const STORE_REAP_BLOCK_RETRY_MS = 15_000

export type StoreLifecycleBlockReason = 'task' | 'confirmation' | 'upload' | 'external'

export function clearStoreReapTimer(storeId: string): void {
  const timer = storeReapTimers.get(storeId)
  if (!timer) return
  clearTimeout(timer)
  storeReapTimers.delete(storeId)
}

export function setStoreLifecycleBlockInternal(storeId: string, reason: StoreLifecycleBlockReason, active: boolean): void {
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

export function tabKey(storeId: string, tabId: string): string {
  return `${storeId}:${tabId}`
}

export function notifyGuestWaiters(tab: Tab): void {
  const key = tabKey(tab.storeId, tab.id)
  const waiters = guestWaiters.get(key)
  if (!waiters) return
  guestWaiters.delete(key)
  const wc = tab.webContents && !tab.webContents.isDestroyed() ? tab.webContents : null
  waiters.forEach(resolve => { try { resolve(wc) } catch { /* ignore */ } })
}

export function generateTabId(): string {
  return `tab_${randomBytes(16).toString('hex')}`
}

/**
 * 页面**主动**导航的白名单判定（§10.1）：站点内跳转、登录重定向都是 http(s)，
 * 交给 assertNavigableUrl 判定即可；file:/javascript:/data: 一律不放行。
 *
 * 不抛错是刻意的：本函数跑在 Electron 的 will-navigate 回调里，异常逃出去会变成主进程
 * uncaughtException（表现为"点链接应用崩"）。空值/无法解析的目标按"未知即拒绝"处理。
 */
export function isAllowedPageNavigation(targetUrl: string): boolean {
  if (!targetUrl) return false
  try {
    assertNavigableUrl(targetUrl)
    return true
  } catch {
    return false
  }
}

/** 标签页崩溃自动重载的节流表（tabId → 上次自动重载时间），防崩溃-重载死循环 */
export const TAB_RELOAD_MIN_INTERVAL_MS = 5 * 60 * 1000
export const tabReloadGuard = new Map<string, number>()
/** did-navigate-in-page 的落库节流（tabId → 上次落库时间）；与 tabReloadGuard 同生命周期清理 */
export const inPageSaveAt = new Map<string, number>()
export const inPageSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

export function getActiveTabId(storeId: string): string | null {
  return browserStates.get(storeId)?.activeTabId ?? null
}

export const storeOpenListeners: Array<(storeId: string) => void> = []
export function onStoreBrowserOpened(cb: (storeId: string) => void): void {
  storeOpenListeners.push(cb)
}

export function getOpenStoreIds(): string[] {
  return Array.from(browserStates.keys())
}

