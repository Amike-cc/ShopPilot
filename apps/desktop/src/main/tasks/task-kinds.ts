/**
 * 任务类型注册表：把「某种任务用什么执行面、入队前准备什么、终态释放什么」从通用引擎里拿出来。
 *
 * 背景（2026-10-19 重构 P0）：达人邀约落地后，`task-runner-execute/control/lifecycle`
 * 三处都写 `run.taskKind === 'creator_invite'` 来决定「用后台页 / 预建 / 释放」。
 * 每加一个后台运行的业务都要改引擎，且很容易漏掉终态或恢复分支。
 *
 * 规则：
 *   · 引擎只认 `surface` 与钩子，不认具体业务名；
 *   · 业务名、purpose、审计事件只出现在这里；
 *   · `prepare` 失败不阻断入队（runner 会保持旧行为，日志里留原因）。
 */

import { acquireBackgroundPage, releaseBackgroundPages } from '../browser/window-manager'
import { recordInviteEvent } from '../services/invite-events'
import { inviteStopReasonLabel } from '@shared/invite-notices'
import { logMain } from '../services/logger'
import type { RunHandle } from './task-runner-registry'

export type TaskExecutionSurface = 'foreground' | 'collection' | 'background'

export interface TaskKindDefinition {
  kind: string
  /** 执行面：用户可见标签页 / 采集专用页 / 主进程隐藏后台页 */
  surface: TaskExecutionSurface
  /** 入队、继续、失败重试之前调用；负责把执行面准备好 */
  prepare?(storeId: string): void
  /** 终态（成功/失败/取消）调用；paused 不调用 */
  release?(storeId: string): void
  /** 终态业务钩子：审计、通知等（引擎本身不写业务事件） */
  onTerminal?(run: RunHandle, status: string, reason: string): void
  /** 成功终态的业务文案（如邀约的停止码/完成轮数）；返回 null 用引擎默认文案 */
  successReason?(run: RunHandle): string | null
}

const definitions = new Map<string, TaskKindDefinition>()

export function registerTaskKind(definition: TaskKindDefinition): void {
  definitions.set(definition.kind, definition)
}

export function getTaskKindDefinition(kind: string | null | undefined): TaskKindDefinition | null {
  if (!kind) return null
  return definitions.get(kind) || null
}

/** 达人邀约：后台隐藏页执行，终态写审计事件。 */
const CREATOR_INVITE_KIND = 'creator_invite'

registerTaskKind({
  kind: CREATOR_INVITE_KIND,
  surface: 'background',
  prepare(storeId: string): void {
    try {
      acquireBackgroundPage(storeId, { purpose: CREATOR_INVITE_KIND })
    } catch (error) {
      // 后台页建不起来不拦入队：保持旧的「等用户开店」行为，但日志里必须留下原因。
      logMain('warn', `[task-kind] ${CREATOR_INVITE_KIND} 预建后台页失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
  },
  release(storeId: string): void {
    releaseBackgroundPages(storeId, CREATOR_INVITE_KIND)
  },
  successReason(run: RunHandle): string | null {
    const stop = inviteStopReasonLabel(run.lastStopReason) || '达到本次上限'
    return `达人邀约结束：${stop}，完成 ${run.lastCompletedRounds} 轮`
  },
  onTerminal(run: RunHandle, status: string, reason: string): void {
    try {
      recordInviteEvent({
        storeId: run.storeId,
        campaignId: run.campaignId,
        runId: run.runId,
        type: `run.${status}`,
        payload: { reason: String(reason || '').slice(0, 200), completedRounds: run.lastCompletedRounds }
      })
    } catch { /* 审计失败不影响状态机 */ }
  }
})
