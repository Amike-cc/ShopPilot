/**
 * Agent Job 租约的**纯规则**（2026-09-26 审计 P2-B）。
 *
 * 之前的 sweep 对每个 `running` 且有 owner 的 Job 一律续租，于是"这台进程还活着"
 * 被当成了"这个 worker 还在干活"：**任何在活进程里卡死的 worker 都永远不会超时**
 * （续租把 lease_expires_at 一直推到未来，过期分支再也进不去），Job 占着执行者的
 * 并发位、也不出现在 recovery_required 里等人处理。
 *
 * 这里把判定拆成纯函数，Main 只负责提供三个事实：有没有活着的执行者（模型请求在飞 /
 * TaskRunner 运行仍在跑）、租约是否过期、是否超过最长运行时限。
 */
export interface LeaseSweepInput {
  /** 'running' | 'waiting_confirmation' | 其它（其它一律 skip，不由本规则处理） */
  status: string
  leaseExpiresAt: number | null
  /** 进入 running 的时刻；null 表示未知（不做最长时限判定，避免误杀老数据） */
  startedAt: number | null
  now: number
  leaseMs: number
  /**
   * 是否有活着的执行者：模型请求在飞（Main 侧 controller 还在）或 TaskRunner 运行仍在跑。
   * 这是"续租"的唯一实质依据。
   */
  liveWorker: boolean
  /** 启动宽限：Job 刚进入 running、controller/运行还没挂上来的窗口，默认 2×leaseMs */
  graceMs?: number
  /** 最长运行时限（毫秒）；0 或未设置 = 不限。到点一律转 recovery_required（不自动重排：可能有副作用） */
  maxRunMs?: number
}

export type LeaseVerdict =
  | { action: 'expire'; code: 'AGENT_JOB_LEASE_EXPIRED'; message: string }
  | { action: 'expire'; code: 'AGENT_JOB_RUN_TIMEOUT'; message: string }
  | { action: 'renew' }
  | { action: 'skip' }

/** 判定一个 running Job 的租约该怎么处理。waiting_confirmation 与其它状态返回 skip。 */
export function evaluateLeaseSweep(input: LeaseSweepInput): LeaseVerdict {
  if (input.status !== 'running') return { action: 'skip' }
  const leaseMs = Math.max(0, Number(input.leaseMs) || 0)
  const graceMs = Math.max(0, Number(input.graceMs ?? leaseMs * 2) || 0)
  const startedAt = Number(input.startedAt)
  const hasStartedAt = Number.isFinite(startedAt) && startedAt > 0
  // 1) 最长运行时限是硬上限：即使执行者还活着也要停下来让人决定（不自动重排）
  if (hasStartedAt && Number(input.maxRunMs) > 0 && input.now - startedAt > Number(input.maxRunMs)) {
    const minutes = Math.round(Number(input.maxRunMs) / 60000)
    return { action: 'expire', code: 'AGENT_JOB_RUN_TIMEOUT', message: `Job 运行超过最长时限（${minutes} 分钟），要求人工选择恢复或取消` }
  }
  // 2) 租约是真过期：交给人工恢复（可能已有副作用，绝不自动重排）
  if (input.leaseExpiresAt != null && Number(input.leaseExpiresAt) > 0 && Number(input.leaseExpiresAt) <= input.now) {
    return { action: 'expire', code: 'AGENT_JOB_LEASE_EXPIRED', message: 'Job 租约过期，要求人工选择恢复或取消' }
  }
  // 3) 有活着的执行者：续租
  if (input.liveWorker) return { action: 'renew' }
  // 4) 刚启动的宽限窗口：还没挂上 controller/运行的正常过渡期
  if (hasStartedAt && input.now - startedAt <= graceMs) return { action: 'renew' }
  // 5) 既没有活着的执行者、也不在宽限期：**不再续租**，让它照常过期进入 recovery_required
  return { action: 'skip' }
}

