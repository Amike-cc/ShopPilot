/**
 * 定时邀约调度器（2026-10-20）。
 *
 * 与 `tasks/scheduler.ts` 分开的原因：那边的语义是「按 everyMs 周期触发采集任务」，
 * 这里是「一次性排期到点拉起一个已创建的批次」。混在一起会让周期任务的
 * 自动采集总开关、锚点计算这些既有规则被动改动，风险不划算。
 *
 * 设计要点：
 *   · 排期存在 `invite_campaigns.scheduled_at`，不靠内存计时器——应用重启后照样能恢复；
 *   · 每 15 秒扫一次「status='scheduled' 且已到点」的行，量级是个位数，代价可忽略；
 *   · 真正的拉起逻辑在 `invite-campaign-service.fireDueInviteCampaigns`，可单测。
 */
import { fireDueInviteCampaigns, type FireDueInviteCampaignsResult } from './invite-campaign-service'
import { logMain } from './logger'

/** 15 秒：比分钟级排期精度高，又不至于每秒查库。 */
export const INVITE_SCHEDULE_INTERVAL_MS = 15_000

let timer: NodeJS.Timeout | null = null

/** 单次节拍（导出给单测/验收直接调用，不依赖真实计时器）。 */
export function tickInviteSchedule(now = Date.now()): FireDueInviteCampaignsResult {
  try {
    const result = fireDueInviteCampaigns(now)
    if (result.fired || result.failed) {
      logMain('info', `[invite-scheduler] 到点批次 fired=${result.fired} failed=${result.failed} deferred=${result.deferred}`)
    }
    return result
  } catch (error) {
    logMain('error', `[invite-scheduler] 节拍失败: ${String((error as Error)?.message || error).slice(0, 200)}`)
    return { fired: 0, deferred: 0, failed: 0 }
  }
}

export function startInviteScheduler(): void {
  if (timer) return
  timer = setInterval(() => { tickInviteSchedule() }, INVITE_SCHEDULE_INTERVAL_MS)
  // 启动即跑一次：应用停机期间到点的批次不该再多等 15 秒。
  tickInviteSchedule()
}

export function stopInviteScheduler(): void {
  if (timer) { clearInterval(timer); timer = null }
}
