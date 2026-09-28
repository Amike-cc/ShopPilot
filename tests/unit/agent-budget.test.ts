import { describe, expect, it } from 'vitest'
import { estimateReserveCost, evaluateDailyBudget } from '@shared/agent-budget'

/**
 * 日预算判定（审计 P0-3 的回归测试）。
 *
 * 修正前的实现（聊天路径 agent-runtime.ts:652 与 Job 路径 :896 各写一遍）：
 *   `if (amount <= 0 || (currency === 'tokens' && used >= amount)) throw ...`
 * → 配 USD 预算时条件恒为 false：预算永不生效，UI 却显示"已配置日预算"。
 * → 且只用"已用量"比较，没有预留，单次调用（max_tokens 最大 128000）就能越过日上限。
 */

const usage = (tokens: number, cost: Record<string, number> = {}) => ({ tokens, costByCurrency: cost })

describe('evaluateDailyBudget：tokens 口径', () => {
  it('未超限放行，达到或超过即阻断（保持原有 >= 语义）', () => {
    expect(evaluateDailyBudget({ budgets: [{ scope: 'agent', currency: 'tokens', amount: 1000 }], usage: usage(999) }).blocked).toBe(false)
    expect(evaluateDailyBudget({ budgets: [{ scope: 'agent', currency: 'tokens', amount: 1000 }], usage: usage(1000) }).blocked).toBe(true)
  })

  it('把本次请求的最大输出作为预留计入：单次调用不能再越过日上限', () => {
    const verdict = evaluateDailyBudget({
      budgets: [{ scope: 'profile', currency: 'tokens', amount: 1500 }],
      usage: usage(400),
      reserve: { outputTokens: 1200 }
    })
    expect(verdict.blocked).toBe(true)
    expect(verdict.code).toBe('AGENT_BUDGET_BLOCKED')
    expect(verdict.message).toContain('预留')
  })

  it('币种留空按 tokens 处理', () => {
    expect(evaluateDailyBudget({ budgets: [{ scope: 'agent', currency: null, amount: 10 }], usage: usage(0) }).blocked).toBe(false)
    expect(evaluateDailyBudget({ budgets: [{ scope: 'agent', currency: '', amount: 10 }], usage: usage(10) }).blocked).toBe(true)
  })

  it('限额 <= 0 视为禁止调用，直接阻断并说清原因', () => {
    const verdict = evaluateDailyBudget({ budgets: [{ scope: 'agent', currency: 'tokens', amount: 0 }], usage: usage(0) })
    expect(verdict.blocked).toBe(true)
    expect(verdict.message).toContain('禁止调用')
  })
})

describe('evaluateDailyBudget：非 tokens 货币不再静默失效', () => {
  const pricing = { currency: 'USD', inputPerMTok: 2, outputPerMTok: 8 }

  it('没配同币种单价 → 明确报不可核算，而不是"看起来在生效"', () => {
    const verdict = evaluateDailyBudget({ budgets: [{ scope: 'profile', currency: 'USD', amount: 5 }], usage: usage(0), pricing: null })
    expect(verdict.blocked).toBe(true)
    expect(verdict.code).toBe('AGENT_BUDGET_UNENFORCEABLE')
    expect(verdict.message).toContain('USD')
  })

  it('单价币种不一致同样算不可核算（避免把 USD 预算拿去和 CNY 成本比）', () => {
    const verdict = evaluateDailyBudget({ budgets: [{ scope: 'profile', currency: 'USD', amount: 5 }], usage: usage(0), pricing: { currency: 'CNY', inputPerMTok: 1, outputPerMTok: 2 } })
    expect(verdict.blocked).toBe(true)
    expect(verdict.code).toBe('AGENT_BUDGET_UNENFORCEABLE')
  })

  it('配了同币种单价：按已用成本 + 本次预留成本比较', () => {
    // 已用 4.5 USD，预算 5 USD
    const near = evaluateDailyBudget({ budgets: [{ scope: 'profile', currency: 'USD', amount: 5 }], usage: usage(0, { usd: 4.5 }), pricing })
    expect(near.blocked).toBe(false)
    // 本次最多输出 1200 token × 8 USD/MTok = 0.0096 → 越过 5 USD
    const over = evaluateDailyBudget({ budgets: [{ scope: 'profile', currency: 'USD', amount: 4.5 }], usage: usage(0, { usd: 4.5 }), pricing, reserve: { outputTokens: 1200 } })
    expect(over.blocked).toBe(true)
    expect(over.message).toContain('USD')
  })

  it('币种大小写不敏感（配置里写过 USD / usd 都算同一种）', () => {
    const verdict = evaluateDailyBudget({ budgets: [{ scope: 'profile', currency: 'USD', amount: 1 }], usage: usage(0, { usd: 2 }), pricing })
    expect(verdict.blocked).toBe(true)
  })
})

describe('estimateReserveCost', () => {
  it('没单价/全 0 单价返回 null（表示算不出成本），有单价按百万 token 折算', () => {
    expect(estimateReserveCost(null, { outputTokens: 1000 })).toBeNull()
    expect(estimateReserveCost({ currency: 'USD', inputPerMTok: 0, outputPerMTok: 0 }, { outputTokens: 1000 })).toBeNull()
    expect(estimateReserveCost({ currency: 'USD', inputPerMTok: 2, outputPerMTok: 8 }, { inputTokens: 1_000_000, outputTokens: 500_000 })).toBe(6)
  })
})
