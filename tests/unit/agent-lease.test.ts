import { describe, expect, it } from 'vitest'
import { evaluateLeaseSweep } from '@shared/agent-lease'

/**
 * 2026-09-26 审计 P2-B：租约 sweep 以前对每个 running 且带 owner 的 Job 无条件续租，
 * 于是"进程还活着"顶替了"worker 还在干活"——卡死的 worker 永不超时。
 * 这里锁死新的判定：只有活着的执行者（或刚启动的宽限窗口）才续租。
 */
describe('evaluateLeaseSweep', () => {
  const base = {
    status: 'running',
    leaseExpiresAt: 0,
    startedAt: 0,
    now: 1_760_000_000_000,
    leaseMs: 30_000,
    liveWorker: false
  }

  it('租约未过期 + 有活执行者 → 续租', () => {
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 10_000, liveWorker: true })).toEqual({ action: 'renew' })
  })

  it('租约未过期但没有任何活执行者 → 不再续租（让它照常过期）', () => {
    // 关键回归：以前这里返回续租，卡死的 Job 因此永远不会进 recovery_required
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 10_000, liveWorker: false, startedAt: base.now - 600_000 }))
      .toEqual({ action: 'skip' })
  })

  it('租约已过期 → 报租约过期并要求人工恢复（不自动重排）', () => {
    const verdict = evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now - 1, liveWorker: false, startedAt: base.now - 600_000 })
    expect(verdict.action).toBe('expire')
    expect(verdict).toMatchObject({ code: 'AGENT_JOB_LEASE_EXPIRED' })
    if (verdict.action === 'expire') expect(verdict.message).toContain('人工')
  })

  it('刚进入 running 的宽限窗口内即使还没挂上 worker 也续租（默认 2×leaseMs）', () => {
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 1_000, startedAt: base.now - 10_000, liveWorker: false })).toEqual({ action: 'renew' })
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 1_000, startedAt: base.now - 70_000, liveWorker: false })).toEqual({ action: 'skip' })
  })

  it('超过最长运行时限 → 即使执行者还活着也停下来交人工（时限优先于续租）', () => {
    const verdict = evaluateLeaseSweep({
      ...base, leaseExpiresAt: base.now + 60_000, liveWorker: true, startedAt: base.now - 31 * 60_000, maxRunMs: 30 * 60_000
    })
    expect(verdict.action).toBe('expire')
    expect(verdict).toMatchObject({ code: 'AGENT_JOB_RUN_TIMEOUT' })
    if (verdict.action === 'expire') expect(verdict.message).toContain('30 分钟')
  })

  it('最长运行时限为 0/未设置时不生效；startedAt 未知也不误杀', () => {
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 60_000, liveWorker: true, startedAt: base.now - 999_999_999, maxRunMs: 0 }))
      .toEqual({ action: 'renew' })
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: base.now + 60_000, liveWorker: true, startedAt: null, maxRunMs: 60_000 }))
      .toEqual({ action: 'renew' })
  })

  it('只处理 running：其它状态一律 skip（waiting_confirmation 由确认超时逻辑管）', () => {
    for (const status of ['waiting_confirmation', 'queued', 'succeeded', 'recovery_required']) {
      expect(evaluateLeaseSweep({ ...base, status, leaseExpiresAt: base.now - 1, liveWorker: true })).toEqual({ action: 'skip' })
    }
  })

  it('租约字段为空（老数据）时不会因为"过期"判定丢作业，只按活执行者/宽限决定', () => {
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: null, liveWorker: true, startedAt: base.now - 1000 })).toEqual({ action: 'renew' })
    expect(evaluateLeaseSweep({ ...base, leaseExpiresAt: null, liveWorker: false, startedAt: base.now - 600_000 })).toEqual({ action: 'skip' })
  })
})
