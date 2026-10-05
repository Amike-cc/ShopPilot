/**
 * 自动采集总开关的读取点（主进程唯一入口）。
 *
 * 为什么集中在这里：销售采集调度器、任务调度器都要判断"现在允许自动跑吗"，
 * 各写各的 SELECT 迟早会出现"一处按开、一处按关"的分歧——那正是"以为取消了自动采集、
 * 结果某个通道还在偷偷跑"的成因。读失败一律按**关**处理（fail-closed）。
 */
import { AUTO_COLLECTION_SETTING, parseAutoCollectionEnabled } from '@shared/constants/collection'
import { getDatabase } from '../db/database'

/** 当前是否允许自动采集。默认 false：只有用户在界面上明确打开才会自动跑。 */
export function isAutoCollectionEnabled(): boolean {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(AUTO_COLLECTION_SETTING) as { value_json?: string } | undefined
    if (!row?.value_json) return parseAutoCollectionEnabled(undefined)
    return parseAutoCollectionEnabled(JSON.parse(row.value_json))
  } catch {
    // 数据库瞬态异常（关库/锁）时按"手动"处理：宁可少采，不可偷偷采
    return parseAutoCollectionEnabled(undefined)
  }
}
