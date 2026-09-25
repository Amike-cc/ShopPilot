import type { AgentPlan } from '@shared/schemas/agent'

export type AgentUiStatus = 'idle' | 'thinking' | 'observing' | 'plan_ready' | 'validating' | 'creating_task' | 'executing_software' | 'running' | 'paused' | 'waiting_confirmation' | 'succeeded' | 'failed' | 'cancelled'

/**
 * TaskRunner 运行状态和 Agent Job 状态都会进入同一张任务卡。
 * blocked_* 不是“还在跑”，必须显示为失败而不是假装成功或一直转圈。
 */
export function statusForJob(value: string): AgentUiStatus {
  if (value === 'waiting_confirmation') return 'waiting_confirmation'
  if (value === 'paused') return 'paused'
  if (value === 'succeeded') return 'succeeded'
  if (value === 'cancelled') return 'cancelled'
  if (['failed', 'blocked_permission', 'blocked_budget', 'recovery_required', 'expired'].includes(value)) return 'failed'
  if (value === 'running' || value === 'queued' || value === 'accepted') return 'running'
  return 'idle'
}

/** Job 状态映射到 AgentPlan 的闭合状态集，避免把执行者状态混进计划状态。 */
export function planStatusForJob(value: string): AgentPlan['status'] {
  if (value === 'running') return 'running'
  if (value === 'waiting_confirmation') return 'waiting_confirmation'
  if (value === 'succeeded' || value === 'failed' || value === 'cancelled') return value
  if (value === 'queued' || value === 'accepted') return 'created'
  return 'failed'
}
