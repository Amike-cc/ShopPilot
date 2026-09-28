/**
 * 日预算判定 —— 纯函数，单一事实来源。
 *
 * 为什么要有这个模块（2026-09-26 审计确认的两个洞）：
 *   1) 聊天路径与 Job 路径各写了一遍同一段判断，且都写成
 *      `if (amount <= 0 || (currency === 'tokens' && used >= amount))`：
 *      配 `USD` 预算时该条件**恒为 false** → 预算永不生效，UI 上却显示"已配置日预算"。
 *   2) 用量只在模型响应返回后落库，判定用"已用量"比较，单次请求没有预留
 *      → 一次调用就能越过日上限（`max_tokens` 最大 128000）。
 *
 * 现在的口径：
 *   · 货币为 `tokens`（或留空）→ 按 token 用量（已用 + 本次预留）比较；
 *   · 其他货币 → 必须能算出成本：Profile 配了**同币种**单价就按成本比较，
 *     没配就明确报 `AGENT_BUDGET_UNENFORCEABLE`（宁可拒绝执行，也不假装预算在生效）；
 *   · 限额 ≤ 0 → 直接阻断（等于禁止调用，而不是"不设限"）。
 */

export interface DailyBudgetEntry {
  /** 便于在错误信息里说清是哪一级的预算卡的 */
  scope: 'agent' | 'profile'
  currency?: string | null
  amount: number
}

export interface BudgetUsageSnapshot {
  /** 当日已用 token（input + output） */
  tokens: number
  /** 当日已知成本，按币种汇总（来自 agent_usage.cost_json） */
  costByCurrency: Record<string, number>
}

export interface PricingLike {
  currency: string
  inputPerMTok?: number
  outputPerMTok?: number
}

export interface BudgetReserve {
  /** 本次请求最多会产生的输入 token（可选，多数路径只预留输出） */
  inputTokens?: number
  /** 本次请求最多会产生的输出 token（= max_tokens） */
  outputTokens?: number
}

export interface BudgetVerdict {
  blocked: boolean
  code?: 'AGENT_BUDGET_BLOCKED' | 'AGENT_BUDGET_UNENFORCEABLE'
  message?: string
}

const OK: BudgetVerdict = { blocked: false }

function normalizeCurrency(value: unknown): string {
  return String(value ?? '').trim().toLowerCase() || 'tokens'
}

/** 本次请求的最坏成本估算；没有可用单价返回 null。 */
export function estimateReserveCost(pricing: PricingLike | null | undefined, reserve: BudgetReserve | undefined): number | null {
  if (!pricing) return null
  const inputRate = Number(pricing.inputPerMTok || 0)
  const outputRate = Number(pricing.outputPerMTok || 0)
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null
  if (inputRate <= 0 && outputRate <= 0) return null
  const inputTokens = Math.max(0, Number(reserve?.inputTokens || 0))
  const outputTokens = Math.max(0, Number(reserve?.outputTokens || 0))
  return Number(((inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate).toFixed(12))
}

function round12(value: number): number {
  return Number(value.toFixed(12))
}

/**
 * 判定是否撞到日预算。返回第一个命中的预算（顺序即调用方给的顺序）。
 * 不做任何 IO，也不读全局状态——调用方负责查用量、传单价。
 */
export function evaluateDailyBudget(input: {
  budgets: DailyBudgetEntry[]
  usage: BudgetUsageSnapshot
  pricing?: PricingLike | null
  reserve?: BudgetReserve
}): BudgetVerdict {
  const usage = input.usage
  const reserve = input.reserve
  const pricing = input.pricing ?? null
  for (const budget of input.budgets) {
    const amount = Number(budget.amount)
    if (!Number.isFinite(amount)) continue
    const currency = normalizeCurrency(budget.currency)
    const scopeLabel = budget.scope === 'profile' ? '模型 Profile' : 'Agent'
    if (amount <= 0) {
      return {
        blocked: true,
        code: 'AGENT_BUDGET_BLOCKED',
        message: `${scopeLabel}日预算为 0 ${budget.currency || 'tokens'}，等于禁止调用模型；请在设置里调整日预算`
      }
    }
    if (currency === 'tokens') {
      const used = Math.max(0, Number(usage.tokens || 0)) + Math.max(0, Number(reserve?.outputTokens || 0)) + Math.max(0, Number(reserve?.inputTokens || 0))
      if (used >= amount) {
        return {
          blocked: true,
          code: 'AGENT_BUDGET_BLOCKED',
          message: `今日模型预算已用完（已用/预留 ${used} tokens，限额 ${amount} tokens）；请在设置里调整日预算或明天再试`
        }
      }
      continue
    }
    const pricingCurrency = pricing ? normalizeCurrency(pricing.currency) : ''
    if (!pricing || pricingCurrency !== currency) {
      return {
        blocked: true,
        code: 'AGENT_BUDGET_UNENFORCEABLE',
        message: `${scopeLabel}日预算配的是 ${budget.currency || currency}，但该 Profile 没有 ${budget.currency || currency} 单价，无法核算成本；请补齐单价，或把日预算改成 tokens`
      }
    }
    const spent = Math.max(0, Number(usage.costByCurrency?.[pricingCurrency] || 0))
    const reserveCost = estimateReserveCost(pricing, reserve) ?? 0
    if (round12(spent + reserveCost) >= amount) {
      return {
        blocked: true,
        code: 'AGENT_BUDGET_BLOCKED',
        message: `今日模型预算已用完（已用/预留 ${round12(spent + reserveCost)} ${pricing.currency}，限额 ${amount} ${pricing.currency}）；请在设置里调整日预算或明天再试`
      }
    }
  }
  return OK
}
