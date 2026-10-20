/**
 * 达人邀约批次启动编排（2026-10-19 重构 P1）。
 *
 * 为什么从 IPC handler 里搬出来：这段逻辑包含「店铺校验 → 同店运行锁 → 日额度 → 建批次
 * → 建任务 → 入队 → 关联 run → 写审计 → 失败回滚」八个步骤，是全模块最容易出错的一段；
 * 放在 IPC 层既不能脱离 Electron 单测，也会让 handler 变成第二个业务入口。
 *
 * 约定：
 *   · 业务拒绝（店铺不存在、已有进行中批次、额度不足）返回 `{ ok:false, code, message }`，
 *     不抛异常；调用方直接映射成 IPC 错误。
 *   · 真正的异常（任务步骤不合法等）继续上抛，由 IPC 层统一分类。
 */

import type { InviteCampaignStartInput } from '@shared/invite-campaign'
import { ERROR_CODES } from '@shared/errors/error-codes'
import type { TaskView, TaskRunView } from '@shared/schemas/task'
import { getDatabase } from '../db/database'
import { getOpenStoreIds } from '../browser/window-manager'
import { checkInviteQuota } from './invite-quota'
import {
  attachInviteCampaignRun,
  attachInviteCampaignTask,
  createInviteCampaign,
  listDueInviteCampaigns,
  markInviteCampaignFailed,
  newInviteCampaignId,
  setInviteCampaignStatus
} from './invite-campaigns'
import { recordInviteEvent } from './invite-events'
import { logMain } from './logger'
import * as TaskStore from '../tasks/task-store'
import * as Runner from '../tasks/task-runner'

export interface StartInviteCampaignSuccess {
  ok: true
  campaignId: string
  task: TaskView
  run: TaskRunView | null
  waitingForStore: boolean
  /** 定时启动时间；立即启动时为 null */
  scheduledAt: number | null
}

/** 排期窗口：至少 1 分钟后（避免点了立刻变"过去时间"），最多 30 天。 */
const MIN_SCHEDULE_LEAD_MS = 60 * 1000
const MAX_SCHEDULE_LEAD_MS = 30 * 24 * 60 * 60 * 1000

export interface StartInviteCampaignFailure {
  ok: false
  code: string
  message: string
}

export type StartInviteCampaignResult = StartInviteCampaignSuccess | StartInviteCampaignFailure

/**
 * 创建批次 + 任务 + 运行。
 *
 * 为什么不分两步（task.create → task.run）：那样批次拿不到 taskId，而且 create 成功、
 * run 失败会留下「有批次没运行」；这里一次编排，失败时把批次标记为 failed。
 */
export function startInviteCampaign(input: InviteCampaignStartInput): StartInviteCampaignResult {
  const storeId = String(input?.campaign?.storeId || input?.task?.storeScope || '')
  if (!input?.task || !input?.campaign || !storeId) {
    return { ok: false, code: ERROR_CODES.INVALID_ARGUMENT.code, message: '缺少任务载荷或店铺' }
  }
  const store = getDatabase()
    .prepare('SELECT id, platform FROM stores WHERE id = ? AND deleted_at IS NULL')
    .get(storeId) as { id: string; platform: string } | undefined
  if (!store) {
    return { ok: false, code: ERROR_CODES.INTERNAL_ERROR.code, message: '店铺不存在或已在回收站' }
  }

  /**
   * 同店同平台只允许一个进行中的邀约批次：多个任务同时操作同一个广场会争页面、
   * 互相把对方的筛选/弹窗切走（真机已多次验证），也会让日额度预留失真。
   * 不同店铺可以分别发起，但任务队列仍是全局串行（见 task-runner-control 的 pump）。
   */
  const active = getDatabase().prepare(`
    SELECT c.id, c.name FROM invite_campaigns c
    JOIN task_runs r ON r.id = c.run_id
    WHERE c.store_id = ? AND c.platform = ?
      AND r.status IN ('queued','running','paused','waiting_confirmation')
    ORDER BY c.created_at DESC LIMIT 1
  `).get(storeId, store.platform) as { id: string; name: string } | undefined
  if (active) {
    return {
      ok: false,
      code: ERROR_CODES.TASK_BAD_STATE.code,
      message: `该店铺已有进行中的邀约批次「${active.name}」，请先停止或等它结束`
    }
  }

  const campaignId = newInviteCampaignId()
  const targetCount = Math.max(1, Math.min(500, Math.round(Number(input.campaign.targetCount) || 1)))
  /**
   * 定时启动：只接受「至少 1 分钟后、30 天内」的时间点。
   * 过去时间不自动降级成"立即发"——那会让用户以为自己排了明天，结果现在就发出去了。
   */
  const rawSchedule = Number(input.campaign.scheduleAt)
  let scheduledAt: number | null = null
  if (Number.isFinite(rawSchedule) && rawSchedule > 0) {
    const now = Date.now()
    if (rawSchedule < now + MIN_SCHEDULE_LEAD_MS) {
      return { ok: false, code: ERROR_CODES.INVALID_ARGUMENT.code, message: '定时启动至少要晚于当前时间 1 分钟' }
    }
    if (rawSchedule > now + MAX_SCHEDULE_LEAD_MS) {
      return { ok: false, code: ERROR_CODES.INVALID_ARGUMENT.code, message: '定时启动最多支持 30 天内' }
    }
    scheduledAt = Math.round(rawSchedule)
  }
  /**
   * 日额度护栏：只在店铺配置了 dailyCap 时硬拦。
   * 未配置时仍统计 used/reserved（页面/侧栏如实展示），但不拿一个拍出来的默认值阻止用户。
   */
  const quota = checkInviteQuota(storeId, store.platform, targetCount)
  if (!quota.ok) {
    return { ok: false, code: ERROR_CODES.INVITE_QUOTA_EXCEEDED.code, message: quota.message }
  }

  createInviteCampaign({
    id: campaignId,
    storeId,
    platform: store.platform,
    name: input.task.name,
    targetCount,
    filters: input.campaign.filters ?? null,
    scriptText: input.campaign.scriptText ?? null,
    productIds: input.campaign.productIds ?? [],
    createdBy: input.campaign.createdBy || 'panel',
    sendMode: input.campaign.sendMode === 'confirm' ? 'confirm' : 'direct',
    scheduledAt
  })

  let task: TaskView
  try {
    task = TaskStore.createTask({
      ...input.task,
      storeScope: storeId,
      kind: 'creator_invite',
      source: input.campaign.createdBy === 'agent' ? 'agent' : input.campaign.createdBy === 'panel' ? 'panel' : 'campaign',
      campaignId
    })
  } catch (error) {
    // 批次已建、任务没建：把批次标成 failed，页面能看到真实结果，而不是一条永远「排队中」的空批次。
    markInviteCampaignFailed(campaignId)
    throw error
  }

  // 排期批次：任务先建好，但不入队。到点由 invite-scheduler 拉起，
  // 这样应用重启后仍能从库里恢复排期（内存计时器做不到）。
  if (scheduledAt) {
    attachInviteCampaignTask(campaignId, task.id)
    recordInviteEvent({
      storeId,
      campaignId,
      type: 'campaign.scheduled',
      payload: { platform: store.platform, targetCount, scheduledAt, createdBy: input.campaign.createdBy || 'panel' }
    })
    return { ok: true, campaignId, task, run: null, waitingForStore: false, scheduledAt }
  }

  try {
    const run = Runner.enqueueRun(task.id, { reason: '达人邀约', storeId })
    try {
      attachInviteCampaignRun(campaignId, task.id, run.runId)
    } catch (error) {
      // run 已入队、任务会照跑：宁可缺一条批次↔run 关联，也不把已在跑的批次谎报成 failed
      //（旧顺序在这里 markInviteCampaignFailed 会留下「批次=failed、任务在跑」的矛盾态，
      // 且 active run 会占住同店锁让用户无法再启动新批次——2026-10-21 审查 P1-5）。
      logMain('warn', `[invite] 批次 ${campaignId} 关联 run 失败（run=${run.runId} 已入队，任务照跑）: ${String((error as Error)?.message || error).slice(0, 200)}`)
    }
    recordInviteEvent({
      storeId,
      campaignId,
      runId: run.runId,
      type: 'campaign.started',
      payload: { platform: store.platform, targetCount, createdBy: input.campaign.createdBy || 'panel' }
    })
    return {
      ok: true,
      campaignId,
      task,
      run: TaskStore.getRun(run.runId),
      waitingForStore: !getOpenStoreIds().includes(storeId),
      scheduledAt: null
    }
  } catch (error) {
    // 走到这里只可能是 enqueueRun 抛（attach 失败已在内层兜底）：run 未创建，标 failed 是如实的
    markInviteCampaignFailed(campaignId)
    logMain('error', `[invite] 批次启动失败 campaign=${campaignId} store=${storeId}: ${String((error as Error)?.message || error).slice(0, 300)}`)
    throw error
  }
}

export interface FireDueInviteCampaignsResult {
  fired: number
  /** 该店还有运行中的批次，留到下个节拍再试 */
  deferred: number
  failed: number
}

/**
 * 到点拉起排期批次（由 `services/invite-scheduler.ts` 每 15 秒调用一次）。
 *
 * 三条规则：
 *   1. 同店同平台已有进行中的批次 → 本次跳过，下个节拍再试（不丢排期）；
 *      但超过 2 小时还让不进去就标失败并写原因，避免永远挂着一个"定时"。
 *   2. 到点重新校验日额度：跨天/夜里已经跑过别的批次时，创建时的额度判断可能过期。
 *   3. 任务被删了 → 批次标失败并说明原因，不产生"永远排期"。
 */
/** 排期等待窗口：同店/同任务被占用时最多让到点批次等这么久，超时放弃（与既有 defer 口径一致）。 */
const SCHEDULE_WAIT_WINDOW_MS = 2 * 60 * 60 * 1000

export function fireDueInviteCampaigns(now = Date.now()): FireDueInviteCampaignsResult {
  const result: FireDueInviteCampaignsResult = { fired: 0, deferred: 0, failed: 0 }
  const due = listDueInviteCampaigns(now)
  if (!due.length) return result
  const db = getDatabase()

  for (const campaign of due) {
    const waitedMs = now - campaign.scheduledAt
    // 同店运行锁：任何挂在本店任一批次下的现行 run 都算忙。
    // 不再排除本批次自己——排期批次在「已 enqueue 但状态还没置 running」的异常窗口里
    // 会被下个节拍重复选中，二次 enqueue 就是双跑；命中一律 defer/放弃（幂等安全）。
    const busy = db.prepare(`
      SELECT c.id FROM invite_campaigns c
      JOIN task_runs r ON r.id = c.run_id
      WHERE c.store_id = ? AND c.platform = ?
        AND r.status IN ('queued','running','paused','waiting_confirmation')
      LIMIT 1
    `).get(campaign.storeId, campaign.platform) as { id: string } | undefined
    if (busy) {
      if (waitedMs > SCHEDULE_WAIT_WINDOW_MS) {
        setInviteCampaignStatus(campaign.id, 'failed', '等待同店运行结束超过 2 小时，排期已放弃')
        recordInviteEvent({ storeId: campaign.storeId, campaignId: campaign.id, type: 'campaign.schedule_abandoned', payload: { waitedMs } })
        result.failed++
      } else {
        result.deferred++
      }
      continue
    }

    const task = campaign.taskId ? TaskStore.getTask(campaign.taskId) : null
    if (!task) {
      setInviteCampaignStatus(campaign.id, 'failed', '任务已被删除，排期已放弃')
      recordInviteEvent({ storeId: campaign.storeId, campaignId: campaign.id, type: 'campaign.schedule_missing_task', payload: {} })
      result.failed++
      continue
    }

    // 任务可能被「任务列表手动直跑」：那个 run 不挂在任何 campaign.run_id 上，上面的
    // 同店锁查不到它，但 enqueueRun 会因任务已有现行 run 抛 TASK_BAD_STATE——旧逻辑会把
    // 用户排好的批次白白标失败，错误文案还是内部错误码。先按 taskId 查一次，与同店锁
    // 同口径 defer/放弃（2026-10-21 审查 P1-4）。
    if (campaign.taskId) {
      const manualRun = db.prepare(`
        SELECT status FROM task_runs
        WHERE task_id = ? AND status IN ('queued','running','paused','waiting_confirmation')
        LIMIT 1
      `).get(campaign.taskId) as { status: string } | undefined
      if (manualRun) {
        if (waitedMs > SCHEDULE_WAIT_WINDOW_MS) {
          setInviteCampaignStatus(campaign.id, 'failed', '该邀约任务正在手动运行，等待超过 2 小时，排期已放弃')
          recordInviteEvent({ storeId: campaign.storeId, campaignId: campaign.id, type: 'campaign.schedule_abandoned', payload: { waitedMs, reason: 'task-manually-running' } })
          result.failed++
        } else {
          result.deferred++
        }
        continue
      }
    }

    const quota = checkInviteQuota(campaign.storeId, campaign.platform, campaign.targetCount)
    if (!quota.ok) {
      setInviteCampaignStatus(campaign.id, 'failed', quota.message)
      recordInviteEvent({ storeId: campaign.storeId, campaignId: campaign.id, type: 'campaign.schedule_blocked', payload: { message: quota.message } })
      result.failed++
      continue
    }

    let enqueued = false
    try {
      const run = Runner.enqueueRun(task.id, { reason: '达人邀约（定时）', storeId: campaign.storeId })
      enqueued = true
      // run 已真实入队后，任何后续失败都不再把批次标 failed——状态如实跟任务走（running），
      // 宁可缺关联/少事件，也不留下「批次=failed、任务在跑」的矛盾态（2026-10-21 审查 P1-5）。
      setInviteCampaignStatus(campaign.id, 'running', null)
      attachInviteCampaignRun(campaign.id, task.id, run.runId)
      recordInviteEvent({
        storeId: campaign.storeId,
        campaignId: campaign.id,
        runId: run.runId,
        type: 'campaign.schedule_fired',
        payload: { scheduledAt: campaign.scheduledAt, firedAt: now, lateMs: Math.max(0, waitedMs) }
      })
      result.fired++
    } catch (error) {
      const message = String((error as Error)?.message || error).slice(0, 200)
      if (enqueued) {
        setInviteCampaignStatus(campaign.id, 'running', null)
        logMain('warn', `[invite] 排期批次后半程失败（run 已入队，批次按 running 继续）campaign=${campaign.id}: ${message}`)
        result.fired++
      } else {
        setInviteCampaignStatus(campaign.id, 'failed', `排期启动失败：${message}`)
        logMain('error', `[invite] 排期批次启动失败 campaign=${campaign.id}: ${message}`)
        result.failed++
      }
    }
  }
  return result
}
