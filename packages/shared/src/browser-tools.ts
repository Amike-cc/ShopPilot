/**
 * 内嵌浏览器的「工具类」口径：缩放档位、下载状态判定、查找命中计数。
 *
 * 三端同源：主进程（download-manager）、渲染层（查找条 / 缩放控件 / 下载行）
 * 与单测都从这里取，避免「界面 20% 一档、主进程 10% 一档」这种各写一套的漂移。
 *
 * 约束：不依赖 electron / vue / DOM，纯函数，可在 node 环境直接跑。
 */

/* ------------------------------- 缩放 ------------------------------- */

/** Chromium 常用缩放档位（50%–200%）。刻意采用浏览器熟悉的档位，不做任意步进。 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const DEFAULT_ZOOM_FACTOR = 1

/**
 * 取与入参最接近的档位。
 * 非法值（NaN / 0 / 负数 / 字符串垃圾）一律回落 100%——缩放是"锦上添花"的能力，
 * 不该因为一条脏的持久化数据把页面渲染成 0 倍（用户会以为页面坏了）。
 */
export function clampZoomFactor(value: unknown): number {
  const factor = Number(value)
  if (!Number.isFinite(factor) || factor <= 0) return DEFAULT_ZOOM_FACTOR
  let best: number = ZOOM_STEPS[0]
  let bestGap = Math.abs(best - factor)
  for (const step of ZOOM_STEPS) {
    const gap = Math.abs(step - factor)
    if (gap < bestGap) {
      best = step
      bestGap = gap
    }
  }
  return best
}

/**
 * 按档位前进/后退一格。
 * 到两端就停在端点（不循环）：Ctrl+加号连按十几下又跳回 50%，比"没反应"更让人困惑。
 */
export function stepZoomFactor(current: unknown, direction: 1 | -1): number {
  const steps: readonly number[] = ZOOM_STEPS
  const index = steps.indexOf(clampZoomFactor(current))
  const next = Math.min(steps.length - 1, Math.max(0, index + direction))
  return steps[next]
}

/** `1` → `100%`；用于工具条与提示文案（只展示档位，不展示 0.6700000001 这种浮点噪声）。 */
export function formatZoomPercent(factor: unknown): string {
  return `${Math.round(clampZoomFactor(factor) * 100)}%`
}

/* ------------------------------- 下载 ------------------------------- */

/** 仍在进行（含暂停）的下载状态：这些状态不能触发店铺冷休眠回收。 */
export const ACTIVE_DOWNLOAD_STATES = ['progressing', 'in_progress', 'paused'] as const

/** 终态：到了这里才允许释放 DownloadItem 引用与"店铺有下载"的占用计数。 */
export const TERMINAL_DOWNLOAD_STATES = ['completed', 'cancelled', 'interrupted'] as const

export function isDownloadActiveState(state: unknown): boolean {
  return (ACTIVE_DOWNLOAD_STATES as readonly string[]).includes(String(state))
}

export function isTerminalDownloadState(state: unknown): boolean {
  return (TERMINAL_DOWNLOAD_STATES as readonly string[]).includes(String(state))
}

/** 下载行文案（主进程状态值 → 中文）；未知状态原样显示，不编造"已完成"。 */
export function downloadStateLabel(state: unknown): string {
  const labels: Record<string, string> = {
    completed: '已完成',
    in_progress: '下载中',
    progressing: '下载中',
    paused: '已暂停',
    cancelled: '已取消',
    interrupted: '中断'
  }
  const key = String(state ?? '')
  return labels[key] || key || '未知状态'
}

/** 是否该在这条下载上显示「暂停/继续/取消」：只有还在跑（含暂停）的才有意义。 */
export function canControlDownload(state: unknown): boolean {
  return isDownloadActiveState(state)
}

/* --------------------------- 商品图片下载器 --------------------------- */

/**
 * 商品图片下载器（浏览器插件）的文件名：`<商品标题>_主图_01.jpg` / `_详情图_01.jpg`。
 * 主进程靠这个识别“插件图片下载”，在 will-download 里先问保存文件夹。
 */
export const PLUGIN_IMAGE_DOWNLOAD_PATTERN =
  /_(主图|详情图)_\d{2}(\(\d+\))?\.(?:jpe?g|png|webp|gif|heic|avif)$/i

/**
 * 插件每批下载前先触发一个 0 字节标记下载；主进程拦截它、同步弹文件夹选择框，
 * 不落盘、不写下载记录。这样“每次点击下载”都会问一次，而不是靠时间窗口猜批次。
 */
export const IMAGE_SAVE_FOLDER_MARKER = '__shopilot_pick_folder__.txt'

export function isPluginImageDownload(fileName: unknown): boolean {
  return PLUGIN_IMAGE_DOWNLOAD_PATTERN.test(String(fileName || ''))
}

/* ------------------------------ 多店保活 ------------------------------ */

/**
 * 后台温缓存店铺数上限。
 * 内存审计口径：每个常驻店铺 guest 约 150MB（仓库自测值），所以默认只留 1 家；
 * 想同时盯两家活动/对账时调大，代价是常驻内存线性上涨。
 */
export const WARM_STORE_LIMITS = {
  min: 1,
  max: 4,
  defaultValue: 1,
  estimatedMbPerStore: 150
} as const

export function clampWarmStoreLimit(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return WARM_STORE_LIMITS.defaultValue
  return Math.min(WARM_STORE_LIMITS.max, Math.max(WARM_STORE_LIMITS.min, n))
}

/** 设置页文案：`2 家 · 约 300MB` */
export function warmStoreLimitLabel(value: unknown): string {
  const n = clampWarmStoreLimit(value)
  return `${n} 家 · 约 ${n * WARM_STORE_LIMITS.estimatedMbPerStore}MB`
}

/* ------------------------------- 查找 ------------------------------- */

/**
 * 查找命中计数：`3/12`。
 * 没命中（含还没开始查）统一 `0/0`——界面上「0/0」比空白更明确地表示"这条路径走过了"。
 */
export function formatFindProgress(matches: unknown, active: unknown): string {
  const total = Number(matches)
  if (!Number.isFinite(total) || total <= 0) return '0/0'
  const current = Number(active)
  if (!Number.isFinite(current) || current <= 0) return `0/${Math.floor(total)}`
  return `${Math.floor(current)}/${Math.floor(total)}`
}
