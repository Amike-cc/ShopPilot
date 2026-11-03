/**
 * 达人邀约批次状态推导（2026-10-25 重构，纯函数）。
 *
 * 从 invite-campaigns 抽出来的原因：这段是"批次到底算完成还是没达成"的唯一判据，
 * 混在带 SQL/Electron 依赖的服务里既没法单测，也容易被顺手改成两套口径。
 *
 * 口径：
 *   · waiting_confirmation → waiting（等人点确认 ≠ 失败）；
 *   · succeeded 时先看停止码是不是"非达成型"（额度/候选/门槛/部分发送），再看实际发送量：
 *     发够 target 才 completed，否则 exhausted；
 *   · 未知 run 状态按 failed（如实，不猜）。
 */
import type { InviteCampaignStatus } from '@shared/invite-campaign'

/** 这些停止码代表"没达到计划量就收工"，不能报「已完成」 */
export const NON_TARGET_STOP_REASONS: ReadonlySet<string> = new Set([
  'TASK_QUOTA_EXCEEDED',
  'TASK_SELECTION_SHORTFALL',
  'TASK_DRAWER_NOT_OPEN',
  'TASK_DAREN_ALREADY_INVITED',
  'TASK_DAREN_NOT_INVITABLE',
  'TASK_PAGE_EXHAUSTED',
  'TASK_LIST_EXHAUSTED',
  // 抖店逐人沟通：连续滚动多屏仍是"当前页都处理过"，没有更多候选，不能报"已完成"
  'TASK_DOU_DIAN_PAGE_VISITED',
  'TASK_SEND_PARTIAL'
])

export function deriveStatus(
  base: string,
  runStatus: string | null,
  stopReason: string | null,
  counts?: { sent: number },
  targetCount?: number,
  /**
   * 这个任务是否真的含邀约 loop（默认 true）。
   * 冒烟/自定义任务（waitMs 之类）没有 loop，也不写邀约记录——它们成功就是成功，
   * 不能因为"记录 0 条 < target"被判成 exhausted（那会把测试任务误报成没达成）。
   */
  hasInviteLoop = true
): InviteCampaignStatus {
  if (!runStatus) {
    // scheduled 必须保留：它是"还没跑"的真实状态，退化成 ready 会让人以为点了没反应。
    return (['draft', 'ready', 'scheduled', 'waiting', 'failed', 'stopped'].includes(base) ? base : 'ready') as InviteCampaignStatus
  }
  if (runStatus === 'queued' || runStatus === 'running') return 'running'
  if (runStatus === 'waiting_confirmation') return 'waiting'
  if (runStatus === 'paused') return 'paused'
  if (runStatus === 'cancelled') return 'stopped'
  if (runStatus === 'failed') return 'failed'
  if (runStatus === 'succeeded') {
    if (stopReason && NON_TARGET_STOP_REASONS.has(stopReason)) return 'exhausted'
    // 没有停止码说明跑满了 maxRounds；只有"实际发够计划量"才算 completed，否则就是没达成。
    if (hasInviteLoop && typeof targetCount === 'number' && targetCount > 0 && typeof counts?.sent === 'number' && counts.sent < targetCount) {
      return 'exhausted'
    }
    return 'completed'
  }
  return 'failed'
}
