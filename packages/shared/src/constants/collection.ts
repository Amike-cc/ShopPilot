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
