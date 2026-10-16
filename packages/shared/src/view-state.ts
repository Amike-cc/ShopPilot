/**
 * 浏览器视图状态：诊断浮层（DashboardBrowserSurface）与「视图体检」（设置中心）共用的唯一口径。
 *
 * 为什么要有这个文件（2026-10-16 审查 V4）：
 *   在此之前，两处各自回答"这个店铺页面现在怎么样"——浮层只看 `guestAttached`（没挂上才说话），
 *   体检只探已挂载的 guest（挂上了才说话）。两者的盲区正好互为对方的领地，却没有任何一处把
 *   它们拼成一张完整的视图状态表：用户在浮层看到「正在连接店铺页面…」，转头点「视图体检」，
 *   得到的结论读起来像"一切正常"。
 *
 * 另外两处判据过去也是各写一遍、各错一半（同一次审查的 V1/V2）：
 *   · `did-fail-load` 的过滤条件（子框架 / 被取消的加载）散在渲染层与主进程两份实现里；
 *   · 探针把"超时未响应"和"进程已消失/求值失败"都归成一种，界面于是把**崩溃**显示成**卡死**；
 *   · 视图地址用 `origin + pathname` 拼接，`about:blank` 会被显示成 `nullblank`。
 *
 * 放在 shared 的原因与 `navigation.ts` / `product-status.ts` 相同：主进程与渲染层读同一份定义，
 * 纯函数、零依赖，单测可直接锁定（`tests/unit/browser-view-state.test.ts`）。
 */

/** 一个店铺视图（标签页 guest）在任一时刻的完整状态。 */
export type BrowserViewState =
  /** 元素还没挂上 / guest 未注册（浮层负责这一段） */
  | 'unattached'
  /** 正在连接：已发起注册但尚未成功 */
  | 'connecting'
  /** 已挂载且页面仍在加载 */
  | 'loading'
  /** 已挂载且加载完成 */
  | 'ready'
  /** 渲染主线程超时未响应（探针能跑但页面卡死） */
  | 'hung'
  /** 渲染进程已消失 / 求值抛异常（与"卡死"是两回事：一个要重载，一个要重开） */
  | 'crashed'
  /** 主框架导航失败（DNS / 代理 / 平台 5xx）——`did-fail-load` 里唯一算"整页失败"的那一类 */
  | 'load_failed'

/** 体检列表用的短标签（界面直接显示） */
export const BROWSER_VIEW_STATE_LABEL: Record<BrowserViewState, string> = {
  unattached: '未挂载',
  connecting: '连接中',
  loading: '加载中',
  ready: '正常',
  hung: '卡死（渲染进程无响应）',
  crashed: '崩溃/异常',
  load_failed: '页面加载失败'
}

/** 诊断浮层用的一句话（与短标签同源，避免两处各写一套措辞） */
export const BROWSER_VIEW_STATE_SENTENCE: Record<BrowserViewState, string> = {
  unattached: '页面尚未挂载',
  connecting: '正在连接店铺页面…',
  loading: '页面加载中…',
  ready: '页面正常',
  hung: '页面无响应（渲染进程卡死）',
  crashed: '页面进程已崩溃',
  load_failed: '页面加载失败'
}

/**
 * `did-fail-load` 里算"被取消"的错误码：不算页面失败。
 * -3 = `net::ERR_ABORTED`：被新导航/重定向/`window.stop()` 打断（Electron 对 did-fail-load 的定义
 * 就是 "fired when the load failed **or was cancelled**"）。
 */
export const CANCELED_LOAD_ERROR_CODES: readonly number[] = [-3]

/** 探针超时的标记（`withTimeout` 用它区分"超时"与"求值失败"）。 */
export const VIEW_PROBE_TIMEOUT_MARKER = 'view-probe-timeout'

/**
 * 判断一次 `did-fail-load` 是否算"整页加载失败"。
 * @returns 失败原因；`null` 表示不算失败（子框架失败 / 被取消 / 无事件）。
 *
 * 两个必须同时成立的条件缺一不可：
 *   · 主框架（子框架是广告、统计、第三方登录 iframe——它们失败不代表页面打不开）；
 *   · 不是取消型错误码（否则用户按了停止、或被重定向打断都会报"页面加载失败"）。
 */
export function classifyLoadFailure(event: {
  errorCode?: unknown
  errorDescription?: unknown
  isMainFrame?: unknown
} | null | undefined): string | null {
  if (!event) return null
  const code = Number(event.errorCode)
  if (Number.isFinite(code) && CANCELED_LOAD_ERROR_CODES.includes(code)) return null
  // 只有明确是子框架时才忽略：拿不到 isMainFrame 的调用方（主进程监听回调）按主框架处理
  if (event.isMainFrame === false) return null
  const description = String(event.errorDescription ?? '').trim()
  if (description) return description
  if (Number.isFinite(code) && code !== 0) return `错误码 ${code}`
  return '未知原因'
}

/**
 * 视图地址的可读展示：**去掉查询串**（token / 重定向参数不进界面与日志），
 * 非 http(s) 地址给可读文案而不是 `origin + pathname` 拼出来的垃圾串。
 *
 * 反例（修复前的实测输出）：`about:blank` → `nullblank`，
 * `chrome-error://chromewebdata/` → `nullchromewebdata`——后一个恰恰是"加载失败"时最该看清的地址。
 */
export function formatViewUrl(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return '（空地址）'
  if (value === 'about:blank') return '空白页（尚未导航）'
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin + parsed.pathname
    if (parsed.protocol === 'file:') return '（应用界面）'
    if (parsed.protocol === 'chrome-error:') return '加载失败页（Chromium 错误页）'
    if (parsed.protocol === 'devtools:') return '（开发者工具）'
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return '（页面内数据）'
    // 兜底：只留协议，不回显可能带凭据的整串
    return `${parsed.protocol}//…`
  } catch {
    return value.slice(0, 80)
  }
}

/** 探针求值结果的三种结局（区分"没响应"与"没了"）。 */
export type ViewProbeOutcome = 'ok' | 'timeout' | 'error'

/**
 * 把探针的异常归类。**这是 V1 的核心**：过去实现写成
 * `withTimeout(...).then(() => 'ok', () => 'hung')`，把超时、销毁、求值失败全归成一种，
 * 于是崩溃（`executeJavaScript` 会 reject）在界面上被显示成"卡死"，
 * 而界面专门为崩溃准备的那一档永远不出现。
 */
export function classifyProbeFailure(error: unknown): { outcome: ViewProbeOutcome; reason?: string } {
  const message = String((error as Error)?.message ?? error ?? '').trim()
  if (message === VIEW_PROBE_TIMEOUT_MARKER) return { outcome: 'timeout' }
  return { outcome: 'error', reason: message ? message.slice(0, 120) : undefined }
}

/** 读取 guest `webContentsId` 的最大尝试次数（有界，避免"一次读不到就当失败"）。 */
export const GUEST_ID_READ_ATTEMPTS = 12

/**
 * 读取 `<webview>` 的 guest `webContentsId` —— 必须容忍"还没就绪"。
 *
 * `did-attach` 触发时 guest 的 `webContentsId` **可能还读不到**：整个面板可见时元素走同步
 * attach 快路径，实测 `did-attach` 时刻读到 `0`、约 40ms 后才可读（`dom-ready` 时必定可读）。
 * 2026-10-16 用户实报的"点侧栏卡片开店后永远停在正在连接"就是这个：旧实现一次读不到就当失败
 * 返回、从不重试注册，而这条失败随后又被 `did-finish-load`（about:blank 也算加载完成）擦掉，
 * 界面于是退回"正在连接店铺页面…"，用户既看不到原因也没有重试按钮。
 *
 * @param read  读一次 guest id 的函数（未就绪时返回 0/非正整数或抛错都算"还没好"）
 * @param sleep 注入等待实现，便于单测（默认 setTimeout）
 * @returns 可用的 guest id；有界次尝试后仍读不到才返回 0（此时如实报错）
 */
export async function readGuestWebContentsId(
  read: () => number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  attempts: number = GUEST_ID_READ_ATTEMPTS
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const id = Number(read())
      if (Number.isInteger(id) && id > 0) return id
    } catch {
      // guest 还没就绪：继续等，不当失败
    }
    if (attempt < attempts - 1) await sleep(attempt < 3 ? 16 : 60)
  }
  return 0
}

/** 探针结果 → 视图状态（主进程探针与界面标签共用同一次归类）。 */
export function classifyProbeState(input: {
  /** 是否已注册 guest；false = 视图还没挂上（浮层负责的那一段） */
  attached: boolean
  destroyed: boolean
  outcome: ViewProbeOutcome
  loading: boolean
}): BrowserViewState {
  // 没挂上不等于崩溃：从未挂载是"未挂载"，曾挂上但进程没了才是"崩溃"
  // （两者处置完全不同：一个是重试注册，一个是重开页面）
  if (!input.attached) return input.destroyed ? 'crashed' : 'unattached'
  if (input.destroyed) return 'crashed'
  if (input.outcome === 'timeout') return 'hung'
  if (input.outcome === 'error') return 'crashed'
  return input.loading ? 'loading' : 'ready'
}
