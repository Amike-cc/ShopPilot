/**
 * 店铺分组：纯逻辑（零 vue / electron / DOM 依赖，可直接单测）
 *
 * 背景：审计确认「分组能看不能设」——`UnifiedStorePage.vue` 只渲染 `groupName`、
 * `stores/workspace.ts` 只按它筛选，主进程 `store:setGroup` 全链路已齐全，缺口只在渲染层没有入口。
 * 这里把「输入清洗 / 合法性 / 有哪些分组 / 分组怎么排」抽成纯函数，保证输入框与列表用**同一套口径**。
 *
 * 约定：
 *   · `groupName` 为 null / 空串 / 纯空白都表示「未分组」；清除分组就是设回 null；
 *   · 保存前先 `normalizeGroupName`：trim → 折叠内部空白 → 空→null → 超长按码点截断；
 *   · `validateGroupName` 在规范化基础上再挡非法字符，返回可直接展示的中文原因。
 */

/** 分组名长度上限（按码点计）；超长是**截断**而不是报错 */
export const STORE_GROUP_MAX_LENGTH = 24

/** 分组相关的店铺最小视图（与 `StoreRow` 结构上兼容） */
export interface StoreGroupInput {
  id: string
  name?: string
  groupName?: string | null
}

export type StoreGroupValidation =
  | { ok: true, value: string | null }
  | { ok: false, message: string }

/**
 * 允许的字符：中英文、数字、空格、`-` `_` `·`。
 * 汉字取常用区（含扩展 A 与「〇」）；全角字母/数字/标点不在白名单里，会被明确拒绝并提示。
 */
const ALLOWED_GROUP_CHARS = /^[\u3400-\u4DBF\u4E00-\u9FFF\u3007A-Za-z0-9 _·-]+$/

/**
 * 规范化分组名：trim → 折叠内部空白 → 空串/纯空白 → null → 超长截断。
 * 非字符串（null / undefined / 数字 / 对象等）一律视为「未分组」，不抛异常。
 */
export function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  const codePoints = Array.from(collapsed)
  if (codePoints.length <= STORE_GROUP_MAX_LENGTH) return collapsed
  // 按码点截断，避免把代理对（emoji 等）切成半个字符；截断位正好是空格时再去掉尾随空格
  return codePoints.slice(0, STORE_GROUP_MAX_LENGTH).join('').trim()
}

/**
 * 校验分组名（保存入口用）：
 *   · 空（null / undefined / 空串 / 纯空白）→ `{ ok: true, value: null }`，语义是「取消分组」；
 *   · 合法 → 返回规范化后的值（超长同样截断，与保存路径同口径）；
 *   · 非法字符、非文本类型 → `{ ok: false, message }`，message 可直接展示给用户。
 */
export function validateGroupName(raw: unknown): StoreGroupValidation {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return { ok: false, message: '分组名必须是文本' }
  }
  const value = normalizeGroupName(raw)
  if (value === null) return { ok: true, value: null }
  if (!ALLOWED_GROUP_CHARS.test(value)) {
    return { ok: false, message: '分组名只能包含中英文、数字、空格和 - _ ·，请去掉其它字符' }
  }
  return { ok: true, value }
}

/**
 * 分组排序：本地化比较。
 * 显式指定简体中文，而不是依赖运行环境的默认 locale（同一份分组在不同机器上顺序一致；
 * 本机默认 locale 就是 zh-CN，`stores/workspace.ts` 既有分组展示用的 `localeCompare` 与之一致）。
 */
function compareGroupNames(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN')
}

/**
 * 列出所有已使用的分组：按规范化后的名字去重、丢弃空值、本地化升序排序。
 * 未分组不产生条目（渲染层用单独的「未分组」兜底）。
 */
export function listStoreGroups(stores: readonly StoreGroupInput[]): string[] {
  const seen = new Set<string>()
  for (const store of stores) {
    const group = normalizeGroupName(store?.groupName)
    if (group !== null) seen.add(group)
  }
  return Array.from(seen).sort(compareGroupNames)
}

/**
 * 按分组整理店铺行：分组之间本地化升序，未分组固定排在最后（`group: null`）。
 *   · 组内保持传入顺序（渲染稳定，不会因为重新分组而跳来跳去）；
 *   · 空分组不出现；没有任何未分组店铺时也不产出 `group: null` 那一行；
 *   · 分组名先规范化再归并，`' 甲 '` 与 `'甲'` 属于同一组，纯空白视为未分组。
 */
export function groupStoreRows(
  stores: readonly StoreGroupInput[]
): Array<{ group: string | null, stores: StoreGroupInput[] }> {
  const buckets = new Map<string, StoreGroupInput[]>()
  const ungrouped: StoreGroupInput[] = []
  for (const store of stores) {
    const group = normalizeGroupName(store?.groupName)
    if (group === null) {
      ungrouped.push(store)
      continue
    }
    const bucket = buckets.get(group)
    if (bucket) bucket.push(store)
    else buckets.set(group, [store])
  }

  const rows = Array.from(buckets.entries())
    .map(([group, items]) => ({ group, stores: items }))
    .sort((a, b) => compareGroupNames(a.group, b.group))

  return ungrouped.length ? [...rows, { group: null, stores: ungrouped }] : rows
}
