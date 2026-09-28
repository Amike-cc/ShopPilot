/**
 * 模型用量与预算的 Main 侧公共实现（审计 P1）。
 *
 * 为什么单独一份：`agent_usage` 的写入与"当日用量快照"原先只在 `agent-runtime.ts` 里，
 * 于是 **legacy AI 栈**（`ai-client.chatComplete`：设置里的「测试连接」与达人邀约话术生成）
 * 完全不计量、不受预算约束——同一份 Key 的消耗有一半进了账，另一半看不见。
 *
 * 本模块只依赖 db 与 shared（不 import agent-runtime / ai-client），因此两边都能安全引用，
 * 不会形成 import 环（agent-runtime 已经 import 了 ai-client.getAiConfig）。
 */

import { randomUUID } from 'crypto'
import { evaluateDailyBudget, type BudgetUsageSnapshot, type DailyBudgetEntry, type PricingLike } from '@shared/agent-budget'
import { ROOT_AGENT_ID } from '@shared/schemas/agent-domain'
import { getDatabase } from '../db/database'

/** 与 AgentRuntimeError 同形（带 code），但独立定义以避免 model-governance ←→ agent-runtime 的循环依赖。 */
export class ModelGovernanceError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ModelGovernanceError'
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value as T
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

function usageValue(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0
}

/** 当日用量快照：token 总数 + 按币种汇总的已知成本（与 qualityMetrics 同口径）。 */
export function dailyUsageSnapshot(agentId: string): BudgetUsageSnapshot {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const db = getDatabase()
  const tokenRow = db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM agent_usage WHERE agent_id=? AND created_at>=?').get(agentId, dayStart.getTime()) as any
  const costRows = db.prepare('SELECT cost_json FROM agent_usage WHERE agent_id=? AND created_at>=? AND cost_json IS NOT NULL').all(agentId, dayStart.getTime()) as Array<{ cost_json: string }>
  const costByCurrency: Record<string, number> = {}
  for (const row of costRows) {
    const item = parseJson<{ amount?: number; currency?: string } | null>(row.cost_json, null)
    const amount = Number(item?.amount)
    const currency = String(item?.currency || '').trim().toLowerCase()
    if (!item || !currency || !Number.isFinite(amount) || amount <= 0) continue
    costByCurrency[currency] = Number(((costByCurrency[currency] || 0) + amount).toFixed(12))
  }
  return { tokens: Number(tokenRow?.tokens || 0), costByCurrency }
}

export interface MeteringTarget {
  agentId: string
  profileId: string
  budgets: DailyBudgetEntry[]
  pricing: PricingLike | null
  /** Profile 的输出上限，用作请求前预留的默认值 */
  maxOutputTokens: number
}

/**
 * legacy AI 配置该记到谁头上：主 Agent 绑定的模型 Profile。
 * `syncMainAgentProfileFromAiConfig()` 保证这份 Profile 与 app_settings 里的 AI 配置同步，
 * 因此它的单价/日预算就是这条链路的治理依据。取不到（未绑定/未启用）时返回 null —— 调用方如实跳过计量。
 */
export function resolveMeteringTarget(agentId: string = ROOT_AGENT_ID): MeteringTarget | null {
  const db = getDatabase()
  const agent = db.prepare('SELECT id, model_profile_id, daily_budget_json FROM agents WHERE id=?').get(agentId) as any
  if (!agent?.model_profile_id) return null
  const profile = db.prepare('SELECT id, daily_budget_json, pricing_json, max_tokens FROM agent_model_profiles WHERE id=?').get(String(agent.model_profile_id)) as any
  if (!profile) return null
  const budgets: DailyBudgetEntry[] = []
  const agentBudget = parseJson<any>(agent.daily_budget_json, null)
  if (agentBudget && typeof agentBudget.amount === 'number') budgets.push({ scope: 'agent', currency: agentBudget.currency, amount: Number(agentBudget.amount) })
  const profileBudget = parseJson<any>(profile.daily_budget_json, null)
  if (profileBudget && typeof profileBudget.amount === 'number') budgets.push({ scope: 'profile', currency: profileBudget.currency, amount: Number(profileBudget.amount) })
  return {
    agentId: String(agent.id),
    profileId: String(profile.id),
    budgets,
    pricing: parseJson<PricingLike | null>(profile.pricing_json, null),
    maxOutputTokens: Math.max(0, Number(profile.max_tokens) || 0)
  }
}

/** 请求前预算校验：把本次请求的最大输出作为预留计入（判定在 shared/agent-budget 的纯函数里）。 */
export function assertMeteredBudget(target: MeteringTarget, reserveTokens: number): void {
  if (!target.budgets.length) return
  const verdict = evaluateDailyBudget({
    budgets: target.budgets,
    usage: dailyUsageSnapshot(target.agentId),
    pricing: target.pricing,
    reserve: { outputTokens: Math.max(0, Number(reserveTokens) || 0) }
  })
  if (verdict.blocked) throw new ModelGovernanceError(verdict.code || 'AGENT_BUDGET_BLOCKED', verdict.message || '达到日预算边界')
}

/**
 * 写一条 agent_usage（§7.3：所有模型调用可计量，失败也留痕）。
 * token 既可从服务商响应里读，也可由调用方直接给（legacy 栈已经在读 usage）。
 */
export function recordModelUsage(input: {
  agentId: string
  profileId: string | null
  parsed?: unknown
  inputTokens?: number
  outputTokens?: number
  status: 'succeeded' | 'failed'
  errorCode?: string | null
  jobId?: string | null
  /** 已知单价时直接用（legacy 栈从 Profile 取）；不传则按 profileId 查库 */
  pricing?: PricingLike | null
  /** 记账成功后的通知（agent-runtime 用它推 event 给界面） */
  onRecorded?: (agentId: string, profileId: string | null, status: string) => void
}): void {
  try {
    const db = getDatabase()
    const profilePricing = input.pricing !== undefined
      ? input.pricing
      : input.profileId
        ? parseJson<PricingLike | null>((db.prepare('SELECT pricing_json FROM agent_model_profiles WHERE id=?').get(input.profileId) as any)?.pricing_json, null)
        : null
    const parsed = input.parsed as { usage?: Record<string, unknown> } | null | undefined
    const inputTokens = input.inputTokens !== undefined ? Math.max(0, Math.floor(Number(input.inputTokens) || 0)) : usageValue(parsed?.usage?.prompt_tokens ?? parsed?.usage?.input_tokens)
    const outputTokens = input.outputTokens !== undefined ? Math.max(0, Math.floor(Number(input.outputTokens) || 0)) : usageValue(parsed?.usage?.completion_tokens ?? parsed?.usage?.output_tokens)
    const inputRate = Number(profilePricing?.inputPerMTok || 0)
    const outputRate = Number(profilePricing?.outputPerMTok || 0)
    const estimatedCost = profilePricing && (inputRate > 0 || outputRate > 0)
      ? Number((((inputTokens * inputRate) + (outputTokens * outputRate)) / 1000000).toFixed(12))
      : null
    const costJson = estimatedCost == null ? null : JSON.stringify({ amount: estimatedCost, currency: String(profilePricing?.currency || 'USD'), source: 'configured_estimate' })
    db.prepare('INSERT INTO agent_usage(id,agent_id,profile_id,job_id,input_tokens,output_tokens,cost_json,estimated,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      `ause_${randomUUID()}`,
      input.agentId,
      input.profileId,
      input.jobId ?? null,
      inputTokens,
      outputTokens,
      costJson,
      estimatedCost != null || (inputTokens === 0 && outputTokens === 0) ? 1 : 0,
      input.status,
      input.errorCode || null,
      Date.now()
    )
    input.onRecorded?.(input.agentId, input.profileId, input.status)
  } catch { /* 记账绝不能打断模型调用本身 */ }
}
