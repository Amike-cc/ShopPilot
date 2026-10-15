/**
 * 数据采集的"自动 / 手动"口径。
 *
 * 背景（2026-10-04 用户要求）："取消所有自动采集，以后改为手动"。
 * 之前的默认行为是**自己跑**：给店铺自动建计划（enabled=1，每 10 分钟一次），
 * 外加每 3 小时的定时任务（如发票采集）。用户在不知情的情况下一直在被自动采集。
 *
 * 现在改为**一个总开关**：
 *   · 默认关闭（fail-closed）——缺省、读不到、值不合法，都按"手动"处理；
 *   · 关闭时：计划可以被建出来但 enabled=0、定时任务不自动触发，所有采集都必须由用户点「立即采集」；
 *   · 打开时：恢复原来的周期采集行为（用户显式要求才开）。
 */
import { INVOICE_TASK_PREFIX } from './invoice'
import { TAX_TASK_PREFIX } from './tax'

export const AUTO_COLLECTION_SETTING = 'collection.autoEnabled'
export const AUTO_COLLECTION_DEFAULT = false

/**
 * 解析开关值。app_settings 里存的是 JSON，历史值可能是 true / "true" / 1 / "1"。
 * 只有明确表示"开"的值才算开——其余（含 undefined / null / 字符串乱填）一律按关处理。
 */
export function parseAutoCollectionEnabled(raw: unknown): boolean {
  if (raw === true || raw === 1) return true
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    return text === 'true' || text === '1'
  }
  return AUTO_COLLECTION_DEFAULT
}

/**
 * 这个任务是不是**后台自动采集**任务（发票采集「每 3 小时」/ 涉税报送采集「按季度」）。
 *
 * 为什么要有它：两个前缀的"不计入任务"口径散在 渲染层列表/统计、概览 SQL 多处，
 * 以前各自为政——2026-10-15 审查 M5 就是"概览总数只排了发票、漏了涉税"。
 * 现在渲染层统一用这一个判定；主进程 SQL 仍用 `PREFIX + '%'`（SQL 里调不了 TS），
 * 由回归测试钉住两边一致。传任务对象或只传名字都可以。
 * 只认前缀，用户自己建的任务只要不占用这两个前缀就不受影响。
 */
export function isBackgroundCollectTask(task: { name?: unknown } | string | null | undefined): boolean {
  const name = typeof task === 'string' ? task : String((task as { name?: unknown } | null | undefined)?.name ?? '')
  return name.startsWith(INVOICE_TASK_PREFIX) || name.startsWith(TAX_TASK_PREFIX)
}

/**
 * 从任务列表里认领"这家店的采集任务"：**取 `updatedAt` 最新的那一个**。
 *
 * 为什么必须是一个统一口径：采集（`ensureCollectTask`）用它复用任务，自动更新开关与
 * 状态条用它找任务改周期——两处口径不同（以前认领按 `updatedAt`、开关按列表序
 * `created_at DESC`）时，库里若有历史重复任务，改周期的和跑数据的可能不是同一个任务，
 * 用户会看到"开了自动更新但数据不动"（2026-10-15 审查 C3）。现在发票/主体的认领、
 * 开关、状态条全部走这一个函数。
 *
 * 只认前缀，不误伤用户自己建的任务；`updatedAt` 缺失按 0 处理（平手时保留先遇到的，
 * 列表按 created_at DESC，先遇到的就是较新的那个）。
 */
export function pickLatestCollectTask<T extends { name?: unknown; storeScope?: unknown; updatedAt?: unknown }>(
  tasks: readonly T[],
  storeId: string,
  namePrefix: string
): T | null {
  let best: T | null = null
  let bestAt = -1
  for (const task of tasks) {
    if (!task || task.storeScope !== storeId) continue
    if (!String(task.name || '').startsWith(namePrefix)) continue
    const at = Number(task.updatedAt || 0)
    if (at > bestAt) { best = task; bestAt = at }
  }
  return best
}
