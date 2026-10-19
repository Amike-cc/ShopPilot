/**
 * 标签页批量关闭的**纯逻辑**：多选状态机 + 关闭请求规划 + 确认/结果文案。
 *
 * 为什么要单独抽一个模块：多选、右键菜单（关闭其他 / 关闭全部）、三个快捷键
 * （Ctrl+W / Ctrl+Shift+W / Ctrl+Alt+W）本来各走各的判据，全内联在
 * DashboardBrowserSurface.vue 里；数量、跳过几个固定标签、"全是固定时不再保留"
 * 这些边界一旦有一处走偏，界面显示的数字和真正关掉的标签就对不上，而这类错误
 * 在组件里只能靠手点验证。这里全部收敛成纯函数：
 *   · 不 import vue / electron / DOM，不读全局状态，同样的输入永远得到同样的输出；
 *   · 确认文案（标题、详情、保留几个固定标签）只在这里生成一处；
 *   · 组件只保留响应式状态与事件接线，行为逐字不变。
 *
 * 三条业务规则（与重构前完全一致）：
 *   ① 多选是"显式选择"：`ids` 模式连固定标签一起关；
 *   ② 「关闭其他 / 关闭全部」是一键操作：默认跳过固定标签；
 *   ③ 但当目标**全是固定标签**时不再保留——否则按钮点了没有任何反应。
 */

/** 批量关闭只关心标签的身份、标题（进确认文案）和是否固定，不依赖完整 TabInfo。 */
export interface BatchCloseTab {
  id: string
  title?: string
  isPinned?: boolean
}

/** 关闭范围：显式多选 / 除某个标签之外 / 全部。 */
export type BatchCloseMode = 'ids' | 'others' | 'all'

/** 一次关闭请求（快捷键、右键菜单、多选工具条都走这一个形状）。 */
export interface BatchCloseRequest {
  mode: BatchCloseMode
  tabIds?: string[]
  keepTabId?: string
}

/** 规划结果：直接驱动二次确认浮层，也是过 IPC 的载荷来源。 */
export interface BatchCloseDialog {
  mode: BatchCloseMode
  tabIds?: string[]
  keepTabId?: string
  includePinned: boolean
  title: string
  detail: string
  /** 实际会关闭的标签数（已扣掉保留的固定标签）。 */
  closeCount: number
  /** 会被保留的固定标签数，0 表示不追加"另有…"提示。 */
  keepPinnedCount: number
}

/** 关闭结果提示的语体：信息（没得关）还是成功（真的关了）。 */
export interface BatchCloseOutcome {
  tone: 'success' | 'info'
  text: string
}

const MODE_LABEL: Record<BatchCloseMode, string> = {
  ids: '选中的',
  others: '其他的',
  all: '全部的'
}

/** 详情里最多预览几个标题，超出只报总数。 */
const PREVIEW_LIMIT = 3
/** 标题过长会撑破确认卡片，按字符截断（与重构前一致）。 */
const TITLE_LIMIT = 12

/** Ctrl/⌘ 点击一项：已选则取消，未选则追加（保持选择顺序，不排序、不去重来源）。 */
export function toggleTabSelection(selected: readonly string[], tabId: string): string[] {
  return selected.includes(tabId)
    ? selected.filter(id => id !== tabId)
    : [...selected, tabId]
}

/**
 * Shift 选择：按标签栏**当前顺序**取区间（与文件管理器一致）。
 * 锚点或目标已不在列表里时退化为只选中目标。
 */
export function selectTabRange(orderedIds: readonly string[], anchorId: string, tabId: string): string[] {
  const from = orderedIds.indexOf(anchorId)
  const to = orderedIds.indexOf(tabId)
  if (from < 0 || to < 0) return [tabId]
  const [start, end] = from <= to ? [from, to] : [to, from]
  return orderedIds.slice(start, end + 1)
}

/** 标签集合变化（关标签 / 换店铺）后收敛选择，避免"选中了一个已经不存在的标签"。 */
export function pruneTabSelection(selected: readonly string[], aliveIds: readonly string[]): string[] {
  const alive = new Set(aliveIds)
  return selected.filter(id => alive.has(id))
}

/** 确认详情：标题预览 + 将被关闭 + 保留几个固定标签。 */
function describeCloseDetail(targets: readonly BatchCloseTab[], skippedPinned: number): string {
  const preview = targets
    .slice(0, PREVIEW_LIMIT)
    .map(tab => `「${(tab.title || '新标签页').slice(0, TITLE_LIMIT)}」`)
    .join('')
  const rest = targets.length > PREVIEW_LIMIT ? ` 等 ${targets.length} 个页面` : ''
  const parts = [`${preview}${rest} 将被关闭，页面里未保存的内容会丢失。`]
  if (skippedPinned > 0) parts.push(`另有 ${skippedPinned} 个固定标签会保留。`)
  return parts.join('')
}

/**
 * 规划一次关闭：算目标 → 出确认文案。
 *
 * 返回 `null` 表示**没有可关闭项**，调用方提示「没有可关闭的标签页」。
 * `others` 模式缺 keepTabId 时同样返回 null（调用方在更外层已经提示过"没有可保留的标签页"）。
 */
export function planBatchClose(tabs: readonly BatchCloseTab[], input: BatchCloseRequest): BatchCloseDialog | null {
  let base: readonly BatchCloseTab[] = []
  if (input.mode === 'ids') {
    const ids = new Set(input.tabIds || [])
    base = tabs.filter(tab => ids.has(tab.id))
  } else if (input.mode === 'others') {
    if (!input.keepTabId) return null
    base = tabs.filter(tab => tab.id !== input.keepTabId)
  } else {
    base = tabs.slice()
  }
  if (!base.length) return null

  // 显式多选连固定一起关；一键操作优先保留固定，但全是固定时不再保留（否则点了没反应）
  const unpinned = base.filter(tab => !tab.isPinned)
  const includePinned = input.mode === 'ids' || unpinned.length === 0
  const targets = includePinned ? base : unpinned
  return {
    mode: input.mode,
    tabIds: input.mode === 'ids' ? targets.map(tab => tab.id) : undefined,
    keepTabId: input.keepTabId,
    includePinned,
    title: `关闭${MODE_LABEL[input.mode]} ${targets.length} 个标签页？`,
    detail: describeCloseDetail(targets, base.length - targets.length),
    closeCount: targets.length,
    keepPinnedCount: base.length - targets.length
  }
}

/** 关闭结果文案：真正关掉几个、保留几个固定标签，或者压根没得关。 */
export function describeCloseResult(result: { closed: number; skippedPinned: number; nothingToClose: boolean }): BatchCloseOutcome {
  if (result.nothingToClose) return { tone: 'info', text: '没有可关闭的标签页' }
  const extra = result.skippedPinned > 0 ? `，保留 ${result.skippedPinned} 个固定标签` : ''
  return { tone: 'success', text: `已关闭 ${result.closed} 个标签页${extra}` }
}
