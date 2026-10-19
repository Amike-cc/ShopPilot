/**
 * 达人邀约日额度（2026-10-19，v2）。
 *
 * 平台额度并不可靠：抖店不显示剩余、微信只在部分页面显示、快手抽屉才显示。
 * 因此本地维护一个**保守口径**：
 *   used      = 今天 invite_records 里已发出的条数（本地确认或平台回读）
 *   reserved  = 今天创建且仍在运行/排队的批次 target_count 之和（已承诺但还没落记录）
 *   limit     = 店铺配置里的 dailyCap（0/缺省 = 不设上限）
 *   remaining = limit - used - reserved（不设上限时为 null）
 *
 * 注意：这不是平台权威额度，只用于防止"同一天连点多次导致本地无限发"。
 * 平台侧额度用尽仍由 TaskRunner 的 TASK_QUOTA_EXCEEDED 正常收尾。
 */
import { getDatabase } from '../db/database'

export interface InviteQuota {
  storeId: string
  platform: string
  used: number
  reserved: number
  /** null = 店铺未设日上限 */
  limit: number | null
  /** null = 未设上限 */
  remaining: number | null
  /** config = 店铺配置；none = 未配置 */
  source: 'config' | 'none'
  dayStart: number
}

function readDailyCap(storeId: string): number {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(`invite.config.store.${storeId}`) as { value_json?: string } | undefined
    if (!row?.value_json) return 0
    const parsed = JSON.parse(row.value_json)
    const value = Number(parsed?.dailyCap)
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  } catch {
    return 0
  }
}

export function getInviteQuota(storeId: string, platform: string): InviteQuota {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const start = dayStart.getTime()
  const db = getDatabase()
  let used = 0
  let reserved = 0
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM invite_records
      WHERE store_id = ? AND invited_at >= ?
        AND status IN ('sent','inviting','accepted','rejected','expired')
    `).get(storeId, start) as { n?: number } | undefined
    used = Number(row?.n) || 0
  } catch { used = 0 }
  try {
    /**
     * 运行中/排队的批次：target_count 是"这一批计划发多少"，不是已发数。
     * 只算今天创建的批次，避免昨天的长跑运行把今天的额度全占掉。
     */
    const row = db.prepare(`
      SELECT COALESCE(SUM(c.target_count), 0) AS n
      FROM invite_campaigns c
      JOIN task_runs r ON r.id = c.run_id
      WHERE c.store_id = ? AND c.platform = ?
        AND c.created_at >= ?
        AND r.status IN ('queued','running','paused','waiting_confirmation')
    `).get(storeId, platform, start) as { n?: number } | undefined
    reserved = Number(row?.n) || 0
  } catch { reserved = 0 }

  const cap = readDailyCap(storeId)
  const limit = cap > 0 ? cap : null
  return {
    storeId,
    platform,
    used,
    reserved,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used - reserved),
    source: cap > 0 ? 'config' : 'none',
    dayStart: start
  }
}

/** 启动前检查：未设上限直接放行；设了上限则 target 不能超过剩余。 */
export function checkInviteQuota(storeId: string, platform: string, target: number): { ok: true; quota: InviteQuota } | { ok: false; quota: InviteQuota; message: string } {
  const quota = getInviteQuota(storeId, platform)
  if (quota.limit == null) return { ok: true, quota }
  const need = Math.max(1, Math.round(Number(target) || 1))
  if (need <= (quota.remaining ?? 0)) return { ok: true, quota }
  return {
    ok: false,
    quota,
    message: `今日额度不足：上限 ${quota.limit}，已发 ${quota.used}，运行中预留 ${quota.reserved}，剩余 ${quota.remaining ?? 0}；本次计划 ${need} 位`
  }
}
