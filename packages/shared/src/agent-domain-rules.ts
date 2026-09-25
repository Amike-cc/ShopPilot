import { createHash } from 'crypto'
import { AGENT_JOB_STATUSES, ROOT_AGENT_ID, type AgentJobCreate } from './schemas/agent-domain'
import { agentSoftwareActionSchema, type AgentSoftwareAction } from './schemas/agent'

export const JOB_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['delegated', 'queued', 'cancelled', 'blocked_permission'], delegated: ['queued', 'cancelled', 'blocked_permission'], queued: ['accepted', 'cancelled', 'expired', 'blocked_budget', 'blocked_permission'],
  accepted: ['running', 'waiting_confirmation', 'cancelled', 'recovery_required'], running: ['waiting_input', 'waiting_confirmation', 'succeeded', 'failed', 'cancelled', 'recovery_required', 'blocked_budget', 'blocked_permission'],
  waiting_input: ['running', 'expired', 'cancelled', 'recovery_required'], waiting_confirmation: ['queued', 'cancelled', 'expired'], failed: ['queued', 'cancelled'], recovery_required: ['queued', 'cancelled'],
  blocked_budget: ['queued', 'cancelled'], blocked_permission: ['queued', 'cancelled'], succeeded: [], cancelled: [], expired: []
}

export function canTransition(from: string, to: string): boolean {
  return (JOB_TRANSITIONS[from] || []).includes(to) && AGENT_JOB_STATUSES.includes(to as (typeof AGENT_JOB_STATUSES)[number])
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function deriveJobRisk(input: Pick<AgentJobCreate, 'goal' | 'inputSummary' | 'browserTask'>): 'read' | 'write' | 'submit' {
  const raw = stableJson({ goal: input.goal, inputSummary: input.inputSummary, browserTask: input.browserTask }).toLowerCase()
  if (/(publish|send|submit|payment|pay|delete|remove|order|checkout|账号|收款|付款|下单|发布|发送|删除)/i.test(raw)) return 'submit'
  // Navigation is a read-only context change; click/fill/select and explicit
  // mutation verbs are the side-effect boundary.
  if (/\b(click|write|fill|select|invite|update|create)\b/i.test(raw)) return 'write'
  return 'read'
}

export const FALLBACK_ALLOWED_ERRORS = ['AI_REQUEST_FAILED', 'AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_PROVIDER_OVERLOADED'] as const
export function canUseFallback(errorCode: string, sideEffectStarted: boolean, highRisk: boolean): boolean {
  return !sideEffectStarted && !highRisk && (FALLBACK_ALLOWED_ERRORS as readonly string[]).includes(errorCode)
}

/**
 * 资金类动作：只有这些动作需要用户审批。
 * 注意“发票”只有在开票/申领语境才算资金；纯采集（发票采集、读取订单）不算。
 */
export const MONEY_ACTION_RE = /(付款|支付|下单|提交订单|确认订单|创建订单|立即购买|去结算|结算|采购|退款|收款|打款|转账|充值|扣款|扣费|开票|开具发票|申请开票|申领发票|投放|广告费|货款|保证金|\b(pay|payment|checkout|purchase|refund|payout|transfer|topup|top-up)\b)/i

/**
 * 只读步骤的载荷不参与资金判定：读取页面上的「退款金额」指标不是退款动作。
 * 目标、任务名、描述、输入摘要和所有可产生副作用的步骤（点击/写入/生成/循环/确认门禁）仍然全量扫描。
 * 清单与 TASK_STEP_TYPES 对齐（apps/desktop/src/main/tasks/task-step-schemas.ts）。
 */
const READ_ONLY_STEP_TYPES: ReadonlySet<string> = new Set([
  'navigate', 'waitForPage', 'waitForSelector', 'readText', 'readTable', 'screenshot',
  'hover', 'pressKey', 'mirrorTabUrl', 'waitForText', 'requireQuota', 'requireEnabled',
  'requireTextAbsent', 'readLabelValue', 'waitMs', 'waitForGone', 'useTab'
])

function stepTypeOf(step: unknown): string {
  if (!step || typeof step !== 'object') return ''
  const record = step as Record<string, unknown>
  const action = record.action
  if (action && typeof action === 'object') return String((action as Record<string, unknown>).type || '')
  return String(record.type || '')
}

function sanitizeMoneySteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps
  return steps.map(step => {
    const type = stepTypeOf(step)
    if (READ_ONLY_STEP_TYPES.has(type)) return { type, description: (step as Record<string, unknown>)?.description }
    return step
  })
}

/** 把真实调用形状（goal + browserTask / goal + steps）清洗成可扫描载荷：只读步骤只看类型。 */
function moneyScanPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (record.browserTask && typeof record.browserTask === 'object') {
    const task = record.browserTask as Record<string, unknown>
    return {
      goal: record.goal,
      name: record.name,
      description: record.description,
      inputSummary: record.inputSummary,
      browserTask: { name: task.name, steps: sanitizeMoneySteps(task.steps) }
    }
  }
  if (Array.isArray(record.steps)) {
    return {
      goal: record.goal,
      name: record.name,
      description: record.description,
      inputSummary: record.inputSummary,
      steps: sanitizeMoneySteps(record.steps)
    }
  }
  return value
}

/** 扫描目标、步骤说明和输入，判断是否属于资金动作；只读步骤的载荷不参与判定。 */
export function isMoneyActionText(value: unknown): boolean {
  return MONEY_ACTION_RE.test(stableJson(moneyScanPayload(value)))
}

/**
 * 除资金外仍需用户审批的例外动作（不可逆/数据销毁类）。
 * 自治运营默认自动执行，列入这里的动作会先展示计划等用户确认。
 */
export const APPROVAL_REQUIRED_SOFTWARE_ACTIONS: readonly string[] = ['deleteStorePermanent']

export function softwareActionNeedsApproval(type: string): boolean {
  return APPROVAL_REQUIRED_SOFTWARE_ACTIONS.includes(type)
}

/**
 * §27.2：普通模型请求最多一次网络重试，且只对连接断开、超时前连接失败
 * 和明确的 429 处理。业务错误（401/403/400/schema）和用户取消不重试。
 */
export function canRetryModelRequest(kind: 'network' | 'http', status: number | null, priorAttempts: number): boolean {
  if (priorAttempts >= 1) return false
  if (kind === 'network') return true
  return status === 429
}

/**
 * 智能体回合输出：模型只允许返回 {"thought": "...", "reply": "...", "actions": [...]}。
 * thought 是一句简短的思考/理由摘要（可以展示给用户）；actions 逐条按闭合白名单校验，
 * 非法动作直接丢弃；返回 null 表示模型没按协议输出，调用方可以把原文当普通对话回复。
 */
export function parseAgentTurnOutput(raw: string, maxActions = 3): { thought: string; reply: string; actions: AgentSoftwareAction[] } | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let json: unknown
  try { json = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  const record = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
  if (!record) return null
  const thought = typeof record.thought === 'string' ? record.thought.trim().slice(0, 500) : ''
  const reply = typeof record.reply === 'string' ? record.reply : ''
  const limit = Math.max(0, Math.min(maxActions, 3))
  const actions: AgentSoftwareAction[] = []
  if (Array.isArray(record.actions)) {
    for (const item of record.actions.slice(0, limit)) {
      const parsed = agentSoftwareActionSchema.safeParse(item)
      if (parsed.success) actions.push(parsed.data)
    }
  }
  if (!thought && !reply && !actions.length) return null
  return { thought, reply, actions }
}

/**
 * 主 Agent（root-ceo）只负责对话、拆分、派单和审核，永远不作为 Job 的执行者。
 * 需要浏览器动作的任务由 Main 从 active 子 Agent 中选一个执行者：
 * 岗位优先级 → 当前负载 → 创建时间，店铺范围必须覆盖目标店铺。
 */
export const AGENT_EXECUTOR_ROLE_PRIORITY: Record<string, number> = {
  operator: 0,
  analyst: 1,
  support: 2,
  content: 3,
  reviewer: 4
}

export type AgentExecutorCandidate = {
  id: string
  role: string
  status: string
  storeScope: { storeIds: string[]; readOnly?: boolean }
  createdAt: number
}

/**
 * 选择 Job 执行者：岗位优先级 → 当前负载 → 创建时间。
 * requireWritable=true（页面写/提交类任务）时只选非只读范围的 Agent（§4.2/§4.3）。
 */
export function selectExecutorAgent<T extends AgentExecutorCandidate>(
  candidates: readonly T[],
  storeId: string | null,
  loadOf: (agentId: string) => number,
  options: { requireWritable?: boolean } = {}
): T | null {
  const eligible = candidates.filter(agent =>
    agent.id !== ROOT_AGENT_ID
    && agent.status === 'active'
    && (!options.requireWritable || agent.storeScope.readOnly !== true)
    && (!storeId || !agent.storeScope.storeIds.length || agent.storeScope.storeIds.includes(storeId))
  )
  if (!eligible.length) return null
  return eligible
    .map(agent => ({ agent, priority: AGENT_EXECUTOR_ROLE_PRIORITY[agent.role] ?? 99, load: loadOf(agent.id) }))
    .sort((a, b) => a.priority - b.priority || a.load - b.load || a.agent.createdAt - b.agent.createdAt)[0].agent
}

export const MEMORY_SENSITIVE_RE = /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_ -]?key|token|secret|password|cookie|authorization|密码|令牌)\s*[:：=]\s*[^\s,，;；]{4,})/i
export const MEMORY_INJECTION_RE = /(ignore\s+(?:all|any|the)\s+previous|忽略(?:之前|上面|系统)指令|system\s+prompt|系统提示词|execute\s+(?:shell|command|任意代码)|执行(?:shell|命令|任意代码)|grant\s+(?:permission|access)|提升权限)/i
