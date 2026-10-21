import { reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import { readGuestWebContentsId } from '@shared/view-state'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * 店铺 `<webview>` 的适配层（ADR-001）：元素登记、attach 注册、attach 看门狗、
 * did-fail-load 失败态、诊断条目与四个规范动作（重试 / 检查代理 / 重新登录 / 清理站点数据）。
 *
 * 从 DashboardBrowserSurface.vue 原样外移：事件名、注册时机与时序完全不变——
 * `did-attach` 先占位（registeringKeys）再 `await readGuestWebContentsId(...)`，
 * 注册完成前页面工具一律按「未就绪」等待；`dom-ready` 兜底再触发一次、已挂上的直接跳过。
 * 组件只留模板/布局与「活动 guest 列表」这个布局输入（openWebviews）。
 */
export interface OpenWebviewEntry {
  key: string
  storeId: string
  tabId: string
  storeName: string
  tabTitle: string
  /** 采集专用页：挂隐藏 webview 给后台采集用，不进标签栏、不参与"未就绪"诊断 */
  internal?: boolean
}

export interface ViewDiagnostic {
  key: string
  storeId: string
  tabId: string
  storeName: string
  failed: boolean
  text: string
}

export interface StoreWebviewsOptions {
  /** 当前活动 guest 列表（组件用 ws 状态算出来的 computed）。 */
  openWebviews: ComputedRef<OpenWebviewEntry[]>
  /** 右侧面板切换与刷新（诊断动作「检查代理」用）。 */
  selectPanel: (key: 'bookmarks' | 'downloads' | 'env' | 'invite') => void
  refreshEnvironment: () => Promise<void>
  /** 平台首页地址表（诊断动作「重新登录」回首页用）。 */
  platformHomeUrls: Ref<Record<string, string>>
}

export function useStoreWebviews(options: StoreWebviewsOptions) {
  const ws = useWorkspaceStore()
  const { openWebviews, selectPanel, refreshEnvironment, platformHomeUrls } = options


const webviewEls = new Map<string, any>()
const webviewRefCallbacks = new Map<string, (element: unknown) => void>()
/** 注册/加载失败的如实原因（key → 文案），成功即清除；界面据此显示诊断而不是空白页。 */
const webviewFailures = reactive<Record<string, string>>({})
const registeringKeys = new Set<string>()
/** attach 看门狗（key → timer）：元素挂载后到点仍没注册成功，就把「正在连接…」升级为可操作的失败。 */
const attachWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
const ATTACH_TIMEOUT_MS = 30_000

function webviewAttached(item: OpenWebviewEntry): boolean {
  const tab = (ws.tabsByStore[item.storeId] || []).find(row => row.id === item.tabId)
  return tab?.guestAttached === true
}

/**
 * 标签页/店铺关掉后，这个 key 不会再回来：把它的 ref 闭包、看门狗、失败记录与在途登记一起回收
 * （2026-10-16 审查 P4-11）。元素登记表 webviewEls 由 Vue 的 ref 回调负责增减，这里不碰；
 * 过去 webviewRefCallbacks 只增不减，一次会话里开过的每个 storeId:tabId 都会永久留一个闭包。
 */
watch(openWebviews, list => {
  const alive = new Set(list.map(entry => entry.key))
  for (const key of Array.from(webviewRefCallbacks.keys())) {
    if (alive.has(key)) continue
    webviewRefCallbacks.delete(key)
    clearAttachWatchdog(key)
    delete webviewFailures[key]
    registeringKeys.delete(key)
  }
})

/** 诊断条目（浮层一行）：失败态与「连接中」共用一份结构，失败才带动作按钮 */

/**
 * 诊断浮层默认收起为一行胶囊（2026-10-21 用户反馈：展开面板挡住浏览器内容太占位）。
 * 失败数仍显示在胶囊上，信息不丢；展开是用户主动动作，不再自动弹开。
 */
const diagnosticsCollapsed = ref(true)

function setWebviewRef(key: string, element: unknown): void {
  if (element) {
    webviewEls.set(key, element)
    // 元素挂上后起看门狗：did-attach 若因 will-attach-webview 被拒等原因永不触发，
    // 30 秒后把「正在连接…」升级为可操作的失败（2026-10-16 审查 P2-3）
    startAttachWatchdog(key)
  } else {
    webviewEls.delete(key)
    clearAttachWatchdog(key)
  }
}

function webviewRefCallback(key: string): (element: unknown) => void {
  const existing = webviewRefCallbacks.get(key)
  if (existing) return existing
  const callback = (element: unknown): void => setWebviewRef(key, element)
  webviewRefCallbacks.set(key, callback)
  return callback
}

async function handleWebviewAttach(item: OpenWebviewEntry): Promise<void> {
  const key = item.key
  if (registeringKeys.has(key)) return
  // 已经挂上就什么都不用做：`dom-ready` 会为每次页面加载再触发一次本函数，
  // 重复注册会让主进程重复挂监听器（window-open / 标题 / 导航拦截各多一份）。
  if (webviewAttached(item)) return
  const element = webviewEls.get(key)
  if (!element) {
    // 元素登记缺失不能静默返回（2026-10-16 审查 P2-4）——留下可见状态，重试按钮仍在
    webviewFailures[key] = '视图元素缺失，未能注册页面'
    return
  }
  clearAttachWatchdog(key)
  // 先占位再 await：`did-attach` 与 `dom-ready` 可能几乎同时打进来，双开注册要挡住
  registeringKeys.add(key)
  try {
    // `did-attach` 时刻 guest 常常还没把 webContentsId 暴露出来（2026-10-16 用户实报：
    // 点侧栏卡片开店 → 面板已可见 → 元素走同步 attach 快路径 → 读到 0）。
    // 这里必须有界等它，读不到才算失败；把"还没好"当失败会让页面永远停在"正在连接"。
    const webContentsId = await readGuestWebContentsId(() => Number(element.getWebContentsId()))
    if (!webContentsId) {
      webviewFailures[key] = '页面进程标识不可读（guest 未就绪），请重试'
      return
    }
    const result = await window.shopilot.browser.registerWebview(item.storeId, item.tabId, webContentsId)
    if (!result.ok) {
      webviewFailures[key] = result.error?.message || '注册失败'
      return
    }
    delete webviewFailures[key]
    const pendingUrl = String((result.data as { pendingUrl?: string } | null)?.pendingUrl || '')
    let current = ''
    try { current = String(element.getURL() || '') } catch { current = '' }
    // 只有真正待导航的地址才加载：about:blank 也调用 loadURL 会把已恢复的页面重新载入一遍
    if (pendingUrl && pendingUrl !== 'about:blank' && (!current || current === 'about:blank')) {
      try { await element.loadURL(pendingUrl) } catch { /* 加载失败由 did-fail-load 如实呈现 */ }
    }
  } finally {
    registeringKeys.delete(key)
  }
}

function startAttachWatchdog(key: string): void {
  clearAttachWatchdog(key)
  attachWatchdogs.set(key, setTimeout(() => {
    attachWatchdogs.delete(key)
    // 只在「既没注册成功、也没失败」时升级为失败——若已成功，webviewFailures 已被清除，
    // 这里不能把已就绪的页面误报成失败
    if (!webviewFailures[key]) {
      webviewFailures[key] = '超过 30 秒仍未就绪（可能被安全策略拦下，可重试或重新打开店铺）'
    }
  }, ATTACH_TIMEOUT_MS))
}

function clearAttachWatchdog(key: string): void {
  const timer = attachWatchdogs.get(key)
  if (timer) {
    clearTimeout(timer)
    attachWatchdogs.delete(key)
  }
}

function retryWebview(key: string): void {
  const item = openWebviews.value.find(entry => entry.key === key)
  if (!item) return
  // 先判后做（2026-10-16 审查 P2-4）：元素登记缺失时保留失败态 + 按钮，别把自救入口点掉
  if (!webviewEls.get(key)) {
    webviewFailures[key] = '视图元素已卸载，请切换标签页或重新打开店铺'
    return
  }
  delete webviewFailures[key]
  void handleWebviewAttach(item)
}

function handleWebviewDestroyed(item: OpenWebviewEntry): void {
  delete webviewFailures[item.key]
  clearAttachWatchdog(item.key)
  // 不再 webviewEls.delete(item.key)（2026-10-16 审查 P2-5）：同一 key 的新元素
  // 可能已挂上，旧元素的 destroyed 是异步派发的，删了会误删新登记。登记的增删
  // 统一交给 Vue 的 ref 回调（挂载给元素 / 卸载给 null）。
}

// ---- 失败卡片的 4 个规范动作（§3.3 / §17.1：重试 / 检查代理 / 重新登录 / 清理站点数据）----
//
// 跨店红线（§3.3「跨店铺切换时显示确认提示，防止把操作发到错误店铺」）：
// 诊断条目可能属于**后台店铺**（openWebviews 遍历所有已打开店铺），而右上环境面板、
// ws.navigate 这些入口看的都是"当前显示的店铺"。所以每个动作都必须先把被诊断的店铺
// 切到前台、再用它自己的 storeId/tabId 调 IPC——直接调 ws.navigate 会把**别的店**导航走。

/** 动作前先把被诊断的店铺显示出来：环境面板与地址栏都跟着 displayedStoreId 走 */
async function focusDiagnosedStore(storeId: string): Promise<void> {
  if (ws.displayedStoreId === storeId) return
  try { await ws.showStore(storeId) } catch { /* 显示失败不阻塞动作本身，下面各自如实报错 */ }
}

async function openProxyPanel(diagnostic: ViewDiagnostic): Promise<void> {
  await focusDiagnosedStore(diagnostic.storeId)
  // 切到右侧「环境」面板——代理绑定/测试入口都在那里（读的是当前显示的店铺）
  selectPanel('env')
  await refreshEnvironment()
}

async function reopenHome(diagnostic: ViewDiagnostic): Promise<void> {
  const target = ws.stores.find(store => store.id === diagnostic.storeId)
  const url = target ? (platformHomeUrls.value[target.platform] || target.adminUrl || '') : ''
  if (!url) {
    ws.toast('这家店铺还没有配置首页地址，请先在地址栏输入并打开', 'error')
    return
  }
  await focusDiagnosedStore(diagnostic.storeId)
  // 必须用被诊断店铺自己的 tabId：navigateTab 在没有 guest 时只记下待导航地址，
  // 之后 registerWebview 会把它作为 pendingUrl 交给渲染层真正载入（window-manager.navigateTab）
  const result = await window.shopilot.browser.navigate(diagnostic.storeId, diagnostic.tabId, url)
  if (!result.ok) {
    ws.toast('重新登录失败：' + (result.error?.message || '未知原因'), 'error')
    return
  }
  retryWebview(diagnostic.key)
}

function clearSiteData(diagnostic: ViewDiagnostic): void {
  // 清理「当前站点数据」：只清站点存储与缓存，**不动 Cookie**（登录态保留）。
  // 类型白名单是 packages/shared/src/schemas/browser.ts 的 ['cookies','cache','localStorage','downloads']
  // ——大小写敏感、最多 4 项；main 侧 'localStorage' 一项即覆盖 localstorage + indexeddb
  // （window-manager.clearStoreData）。写成 'indexdb'/'cachestorage' 会被 schema 拒绝、永远报参数不合法。
  void window.shopilot.browser.clearData(diagnostic.storeId, ['localStorage', 'cache'])
    .then(result => {
      if (result.ok) ws.toast(`已清理 ${diagnostic.storeName} 站点数据（登录态保留）`, 'success')
      else ws.toast('清理失败：' + (result.error?.message || '未知原因'), 'error')
    })
    .catch(() => ws.toast('清理失败：请求异常', 'error'))
}

  /** 卸载清理：看门狗与元素登记/ref 闭包一起清（原组件 onBeforeUnmount 的清理段）。 */
  function dispose(): void {
    for (const key of Array.from(attachWatchdogs.keys())) clearAttachWatchdog(key)
    webviewEls.clear()
    webviewRefCallbacks.clear()
  }

  return {
    webviewEls,
    webviewRefCallbacks,
    webviewFailures,
    registeringKeys,
    attachWatchdogs,
    ATTACH_TIMEOUT_MS,
    webviewAttached,
    diagnosticsCollapsed,
    setWebviewRef,
    webviewRefCallback,
    handleWebviewAttach,
    startAttachWatchdog,
    clearAttachWatchdog,
    retryWebview,
    handleWebviewDestroyed,
    focusDiagnosedStore,
    openProxyPanel,
    reopenHome,
    clearSiteData,
    dispose
  }
}

export type StoreWebviewsApi = ReturnType<typeof useStoreWebviews>
