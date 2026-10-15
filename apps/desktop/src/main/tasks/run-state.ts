/**
 * 任务运行状态机（纯逻辑）
 *
 * 2026-10-15 审查 P1-1 第一步：从 task-runner.ts（4230 行、execStep 单函数 ≈2680 行）里
 * 抽出的第一块**可脱离 Electron 直接单测**的纯逻辑——状态迁移表、迁移断言、
 * "未结束状态"判定与进度阶段映射。task-runner 继续负责副作用（落库/日志/事件），
 * 本文件只回答"能不能迁移、映射到什么阶段"。
 *
 * §9.2 状态机（含 A1 修订的失败恢复迁移）：failed -> queued / failed -> running 允许
 * "从失败恢复"；副作用步骤不进入自动重试范围（由 nonResumable 判定控制，不在本文件）。
 */

import type { TaskProgressPhase } from '@shared/schemas/task'

export const TASK_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_confirmation',
  'paused',
  'succeeded',
  'failed',
  'cancelled'
] as const

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number]

/** 允许的迁移（唯一来源：task-runner 的 transition 与单测都读它） */
export const TASK_RUN_TRANSITIONS: Record<TaskRunStatus, readonly TaskRunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_confirmation', 'paused', 'succeeded', 'failed', 'cancelled'],
  waiting_confirmation: ['running', 'cancelled'],
  paused: ['queued', 'running', 'cancelled'],
  failed: ['queued', 'running'],
  succeeded: [],
  cancelled: []
}

/**
 * "未结束运行"状态：同一任务同一时刻只允许存在一个（避免重复点击/定时叠加
 * 造成真实副作用重复执行）。terminal（succeeded/failed/cancelled）不在其中。
 */
const ACTIVE_RUN_STATUSES: readonly string[] = ['queued', 'running', 'waiting_confirmation', 'paused']

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.includes(status)
}

export function isTerminalRunStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export function isRunTransitionAllowed(from: string, to: string): boolean {
  const allowed = (TASK_RUN_TRANSITIONS as Record<string, readonly string[] | undefined>)[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/** 断言迁移合法；非法时抛 `TASK_BAD_STATE: from -> to (reason)`——IPC 层 taskError 依赖该格式解析状态上下文 */
export function assertRunTransition(from: string, to: string, reason: string): void {
  if (!isRunTransitionAllowed(from, to)) {
    throw new Error(`TASK_BAD_STATE: ${from} -> ${to} (${reason})`)
  }
}

/** 状态 → 进度事件阶段（emitProgress 用）；未列举的状态按 'started' 处理（与旧实现一致） */
export function progressPhaseForStatus(to: string): TaskProgressPhase {
  switch (to) {
    case 'running':
      return 'started'
    case 'succeeded':
      return 'finished'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'finished'
    case 'paused':
      return 'paused'
    case 'queued':
      return 'queued'
    default:
      return 'started'
  }
}
