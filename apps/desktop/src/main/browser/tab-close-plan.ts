/**
 * 标签页批量关闭计划（纯逻辑）- §4.3
 *
 * 「关哪些 / 保留哪些 / 统计结果」的决策从 `window-manager.ts` 的 `closeTabs()` 抽出：
 * 这里只做集合运算，不 import electron / node，也不碰 state、DB、日志，因此可以直接单测。
 * 实际执行（逐个 closeTab、落库、emit）仍由 window-manager 负责。
 *
 * 行为与抽取前的内联实现逐字一致：
 *   · 采集专用页（internal === true）永远不参与；
 *   · `ids` 是用户明确点选的集合，固定标签也关（渲染层对该模式恒传 includePinned=true）；
 *   · `others` / `all` 是一键操作，默认保留固定标签（includePinned === true 才一起关）。
 *
 * 注意一处**旧实现的原样口径**：`includePinned !== true` 时「剔除固定标签」这一步对三种 mode 都生效
 * （ids 也不例外，被剔除的进 skippedPinnedIds）。IPC 边界上 ids 恒为 includePinned=true
 * （`browserTabsCloseManySchema` 的约定 + 渲染层 `features/workbench/tabs-batch-close.ts` 的
 * `input.mode === 'ids' || unpinned.length === 0`），因此该分支不影响线上行为；
 * 这里为了「行为逐字不变 / 可对照」不做特判，将来若要改属于行为变更。
 */

/** 计划需要的最小标签视图（`Tab` 结构上兼容）。 */
export interface TabCloseTarget {
  id: string
  isPinned?: boolean
  internal?: boolean
}

export interface TabCloseRequest {
  mode: 'ids' | 'others' | 'all'
  /** mode === 'ids' 时用户明确点选的标签 id 集合；未知 id、重复 id 都会被安全忽略 */
  tabIds?: string[]
  /** mode === 'others' 时要保留的标签 id */
  keepTabId?: string
  /** 一键操作是否连固定标签一起关（默认 false：保留固定标签） */
  includePinned?: boolean
}

export interface TabClosePlan {
  /** 实际要关闭的标签 id，保持传入顺序 */
  targetIds: string[]
  /** 因「一键操作默认保留固定标签」而跳过的标签 id，渲染层要如实告诉用户 */
  skippedPinnedIds: string[]
  /** 计划执行后仍存活的可见标签数 = 可见标签数 - 关闭数 */
  remaining: number
  /** 没有可关闭的标签页（空标签栏 / 选中的都已不存在） */
  nothingToClose: boolean
}

/**
 * 计算批量关闭计划。
 *
 * @param tabs  当前该店铺的全部标签快照（含采集专用页）
 * @param input 批量关闭请求（与 IPC 的 CloseTabsInput 同形）
 */
export function planTabClose(tabs: readonly TabCloseTarget[], input: TabCloseRequest): TabClosePlan {
  // 采集专用页不参与：关掉它会打断正在跑的采集，用户也看不见它
  const visibleTabs = tabs.filter(tab => tab.internal !== true)
  const selected = new Set(input.tabIds || [])

  let targets: readonly TabCloseTarget[]
  if (input.mode === 'ids') {
    // 用户明确点选：固定标签也关（线上恒有 includePinned=true 配合）
    targets = visibleTabs.filter(tab => selected.has(tab.id))
  } else if (input.mode === 'others') {
    targets = visibleTabs.filter(tab => tab.id !== input.keepTabId)
  } else {
    // 'all'，以及调用方 schema 本应拦掉的未知 mode（与旧实现 if/else 链的兜底一致）
    targets = visibleTabs.slice()
  }

  const includePinned = input.includePinned === true
  // 旧实现口径：includePinned 缺省/为 false 时，三种 mode 都跳过固定标签
  const skippedPinnedIds = includePinned ? [] : targets.filter(tab => tab.isPinned).map(tab => tab.id)
  if (!includePinned) targets = targets.filter(tab => !tab.isPinned)

  const targetIds = targets.map(tab => tab.id)
  return {
    targetIds,
    skippedPinnedIds,
    remaining: visibleTabs.length - targetIds.length,
    nothingToClose: targetIds.length === 0
  }
}
