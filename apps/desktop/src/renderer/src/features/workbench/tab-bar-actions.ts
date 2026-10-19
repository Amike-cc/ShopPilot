/**
 * 标签栏「固定 / 拖拽重排」的**纯逻辑**（2026-10-18）。
 *
 * README 的「核心能力」早就写明标签页支持「固定 / 重排 / 独立窗口」，IPC
 * （`browser:tab:setPinned` / `browser:tab:reorder`）、preload 与类型全链路齐全，
 * 但渲染层一直没有入口——「固定」只差右键菜单一项、重排只差拖拽。这个模块只做
 * 与界面无关的判断：
 *   · 菜单文案与"点一下之后应该变成什么"；
 *   · 拖拽落点 → 新顺序（含各种非法/退化输入）；
 *   · 落点在标签的左半还是右半。
 * 零 vue / electron / DOM 依赖，同样的输入永远得到同样的输出。
 *
 * 两条约定：
 *   ① 固定标签**不强制**排到最前——用户拖到哪就是哪（与浏览器书签栏不同，
 *      这里不替用户改顺序）；
 *   ② 任何找不到的 id、自己拖自己、空列表，都安全返回原顺序的**副本**，
 *      绝不产生重复 id（主进程 schema 会拒绝重复列表）。
 */

/** 固定状态只关心 `isPinned`，不依赖完整 TabInfo。 */
export interface PinnableTab {
  isPinned?: boolean
}

/** 一次拖拽落点：把 draggedId 放到 targetId 的前/后。 */
export interface TabOrderMove {
  draggedId: string
  targetId: string
  position: 'before' | 'after'
}

/** 右键菜单里的固定项文案：未固定 → 「固定标签页」，已固定 → 「取消固定」。 */
export function pinMenuLabel(tab: PinnableTab): string {
  return tab.isPinned ? '取消固定' : '固定标签页'
}

/** 点击固定项之后的目标状态（永远取反）。 */
export function nextPinnedState(tab: PinnableTab): boolean {
  return !tab.isPinned
}

/**
 * 算出重排后的完整 id 顺序（返回新数组，不改入参）。
 *
 * 以下情况一律返回原顺序的副本：列表为空、draggedId 与 targetId 相同、
 * 任一个不在列表里（被别的操作关掉了 / 拖拽状态没清干净）。
 */
export function computeReorderedIds(orderedIds: readonly string[], move: TabOrderMove): string[] {
  const ids = [...orderedIds]
  if (move.draggedId === move.targetId) return ids
  const from = ids.indexOf(move.draggedId)
  const to = ids.indexOf(move.targetId)
  if (from < 0 || to < 0) return ids
  const [moved] = ids.splice(from, 1)
  // 摘掉被拖项后目标的下标会变（往右拖时整体左移一位），必须重新定位，
  // 否则向右拖永远差一格
  const anchor = ids.indexOf(move.targetId)
  ids.splice(move.position === 'before' ? anchor : anchor + 1, 0, moved)
  return ids
}

/**
 * 落点在标签的哪一半：左半 → 插到它前面，右半 → 插到它后面。
 * 宽度拿不到（0 / NaN，例如元素刚被隐藏）时退化为 'after'，不会算出 NaN 下标。
 */
export function tabDropSide(rect: { left: number; width: number }, clientX: number): 'before' | 'after' {
  if (!(rect.width > 0)) return 'after'
  return clientX < rect.left + rect.width / 2 ? 'before' : 'after'
}
