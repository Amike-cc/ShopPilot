/**
 * 视图级诊断：探针（正常/加载中/卡死/崩溃）与内存诊断（标签/页面租约为什么还开着）。
 * 2026-10-19 P1 重构：由 window-manager.ts 等价搬迁（实现逐字保留）。
 */

import { webContents } from 'electron'
import { StorePageLeases } from './page-lease'
import { VIEW_PROBE_TIMEOUT_MARKER, classifyProbeFailure, classifyProbeState, formatViewUrl } from '@shared/view-state'
import type { BrowserViewState } from '@shared/view-state'
import { getActiveDownloadStoreIds } from './download-manager'
import { displayedStoreId, storeLifecycleBlockReasons } from './window-browser-core'
import { STORE_WARM_CACHE_LIMIT, browserStates, pageLeases, standaloneWindows, storeLifecycle, taskAwakeStores } from './window-state'
import type { Tab } from './window-state'

/** 视图级探针结果（「视图体检」核心）：直接回答"这个店铺页面是正常/加载中/卡死/崩溃"。 */
export interface ViewProbe {
  storeId: string
  tabId: string
  /** 只回 origin + path，不带查询串（隐私：不泄漏 token/redirect 参数） */
  url: string
  title: string
  /** 页面当前是否在加载（isLoading，非阻塞） */
  loading: boolean
  /** webContents 是否已销毁（探针无法执行） */
  destroyed: boolean
  /** guest 是否已注册。**未挂载的视图也出现在结果里**（2026-10-16 审查 V4）——
   *  过去只探已挂载的，导致"浮层说正在连接、体检说一切正常"这种互为盲区的结论。 */
  attached: boolean
  /** 采集专用页（后台隐藏视图）：诊断里保留，但界面要标注它不是用户打开的那一个 */
  internal: boolean
  /**
   * 视图状态（@shared/view-state 的唯一口径）。
   * 与旧 `responsive: 'ok'|'hung'|'error'` 的区别：**崩溃不再被归成"卡死"**——
   * 超时是 `hung`，进程消失/求值失败是 `crashed`，两者在界面上的处置完全不同。
   */
  state: BrowserViewState
  /** 非 ok 状态的可读原因（脱敏、截断） */
  reason?: string
}

/** 视图探针超时（ms）：挂起的 renderer 会让 executeJavaScript 无限期不返回，必须限时。 */
const VIEW_PROBE_TIMEOUT_MS = 3000

/** 对单个 guest 做只读探针（不读正文/凭据；URL 去查询串；带超时，挂起不阻塞）。 */
async function probeView(tab: Tab, storeId: string): Promise<ViewProbe> {
  const internal = tab.internal === true
  const base = { storeId, tabId: tab.id, internal }
  const wc = tab.webContents
  const attached = !!wc && !wc.isDestroyed() && tab.guestAttached === true
  if (!attached) {
    // 没挂上（或曾挂上但进程已销毁）：也算一行，状态交给判据统一给——
    // 从未挂载是"未挂载"（可重试注册），曾挂上但进程没了是"崩溃"（要重开页面）
    const destroyed = !!wc && wc.isDestroyed()
    return {
      ...base,
      url: formatViewUrl(tab.url),
      title: tab.title || '',
      loading: false,
      destroyed,
      attached: false,
      state: classifyProbeState({ attached: false, destroyed, outcome: 'error', loading: false })
    }
  }
  let loading = false
  let title = tab.title || ''
  let url = tab.url
  let reason: string | undefined
  try {
    loading = wc!.isLoading()
    url = wc!.getURL() || tab.url
    title = wc!.getTitle() || tab.title || ''
  } catch (error) {
    // getURL/getTitle 对已销毁 contents 会抛，按不可读处理
    reason = String((error as Error)?.message || error).slice(0, 120)
  }
  let outcome: 'ok' | 'timeout' | 'error' = 'ok'
  try {
    await withTimeout(wc!.executeJavaScript('1', true), VIEW_PROBE_TIMEOUT_MS)
  } catch (error) {
    // 超时 ≠ 崩溃（2026-10-16 审查 V1）：过去 `then(() => 'ok', () => 'hung')` 把两者混成一个
    const classified = classifyProbeFailure(error)
    outcome = classified.outcome
    if (classified.reason) reason = classified.reason
  }
  return {
    ...base,
    url: formatViewUrl(url),
    title,
    loading,
    destroyed: false,
    attached: true,
    state: classifyProbeState({ attached: true, destroyed: false, outcome, loading }),
    ...(reason ? { reason } : {})
  }
}

/**
 * 给 Promise 套超时：到点先归失败，绝不让挂起的视图卡住诊断本身。
 *
 * 注意（2026-10-16 审查 V3）：超时**不等于取消**——`executeJavaScript` 没有取消接口，
 * 底层 promise 仍会挂着（真挂死的 renderer 上每次体检留一个 pending promise，量级可忽略）。
 * 这里只保证"诊断自己不会跟着卡住"。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 标记串与 @shared/view-state 的 VIEW_PROBE_TIMEOUT_MARKER 一致：
    // classifyProbeFailure 靠它区分"超时未响应"与"进程已消失/求值失败"
    const timer = setTimeout(() => reject(new Error(VIEW_PROBE_TIMEOUT_MARKER)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

/** 只读性能采样：返回主进程、Electron 子进程、店铺页面生命周期摘要，以及视图级探针。 */
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
  /** 视图体检：每个已挂载 guest 的加载/挂起/崩溃状态（并发探针，单个挂起不影响整体） */
  views: ViewProbe[]
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
  // 视图体检：**所有**标签页都成行（含未挂载的），并发探针（Promise.all 不短路——
  // 单个视图挂起只在它自己的超时里等待，不会拖慢整体，也不阻塞别的视图）。
  // 过去只探已挂载的 guest，于是"浮层说正在连接、体检说没有视图"互为盲区（2026-10-16 审查 V4）；
  // 未挂载的视图不执行页面脚本，只回报状态（见 probeView 的 attached 分支）。
  const views = await Promise.all(
    Array.from(browserStates.entries()).flatMap(([storeId, state]) =>
      Array.from(state.tabs.values())
        .map(tab => probeView(tab, storeId))
    )
  )
  return {
    capturedAt: Date.now(),
    main: process.memoryUsage(),
    appMetrics: metrics,
    stores: storeRows,
    views,
    /** 后台采集借用的页面：谁还开着、是借用中还是用户接手（"占用为什么没降下来"看这里） */
    pageLeases: pageLeases.snapshot(),
    activeDownloads: getActiveDownloadStoreIds(),
    totals: { openStores: storeRows.length, tabs, attachedGuests, standaloneWindows: standaloneCount, webContents: webContents.getAllWebContents().length }
  }
}

