import { createHash } from 'crypto'
import { AGENT_JOB_STATUSES, ROOT_AGENT_ID, type AgentJobCreate } from './schemas/agent-domain'
import { hasSideEffectSteps } from './agent-step-effects'
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
  // 步骤类型是权威信号：文案正则匹配不到 `"type":"clickByText"` / setInput / typeText / aiGenerate /
  // ensureRows* / useTab / loop / clickAll / clickIfPresent（`\bclick\b` 要求词边界），
  // 只靠文案会把这类浏览器 Job 判成 read —— 既可能派给只读执行者，又会被"安全恢复"重放。
  // 名单来自 shared/agent-step-effects.ts（单一事实来源）。
  if (hasSideEffectSteps(input.browserTask)) return 'write'
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
 * 除资金外仍需用户审批的例外动作（持久化任务、关闭标签页和不可逆/数据销毁类）。
 * 自治运营默认自动执行，列入这里的动作会先展示计划等用户确认。
 */
export const APPROVAL_REQUIRED_SOFTWARE_ACTIONS: readonly string[] = ['deleteStorePermanent', 'createTask', 'closeTab']

export function softwareActionNeedsApproval(type: string): boolean {
  return APPROVAL_REQUIRED_SOFTWARE_ACTIONS.includes(type)
}

/**
 * 会真实改动持久状态的软件动作（店铺/任务/技能/插件/组织/备份/邀约…）。
 *
 * **与"是否需要人工确认"是两件事**，这里必须分开：
 *   · 风险等级（risk=write）与 `side_effect_started`、只读执行者过滤、可恢复重放判定都看**副作用**；
 *   · 是否先弹确认只影响"谁点头"，不该反过来决定"能不能重放""能不能给只读 Agent"。
 * 以前 `planFromActions` 用确认集合同时推 risk，两者一绑，任何一次"少要一次确认"的调整
 * 都会顺手把风险降级成 read（审计 P0-1 的同一类问题）。
 */
export const AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS: ReadonlySet<string> = new Set([
  'closeStore', 'closeTab', 'createAgent', 'activateAgent', 'pauseAgent', 'resumeAgent', 'retireAgent',
  'createTask', 'deleteTask', 'runTask', 'cancelTaskRun', 'updateTask',
  'createStore', 'updateStore', 'archiveStore', 'restoreStore', 'deleteStorePermanent',
  'restoreBackup',
  'createBookmark', 'deleteBookmark',
  // 达人邀约会把私信真的发出去（提交类），风险等级必须是 write
  'runInvite',
  'createSkill', 'updateSkill', 'deleteSkill', 'createPlugin', 'updatePlugin', 'deletePlugin',
  'approveJob', 'reviewJobResult', 'cancelJob',
  'updateAgent', 'bindAgentModel',
  'applyEntity'
])

export function softwareActionHasSideEffect(type: string): boolean {
  return AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS.has(type)
}

/**
 * 需要用户先确认的软件动作。
 *
 * 口径（2026-09-26 用户定调）：**"由用户自己在对话里发起"的动作不再要求二次确认**——
 * 达人邀约（`runInvite`，额度用尽自动停止，明细进实时日志）与技能启用/停用（`updateSkill`，
 * 可逆的本地定义变更）已撤出本名单；它们仍在 `AGENT_SIDE_EFFECT_SOFTWARE_ACTIONS` 里，
 * 因此风险等级、只读执行者过滤与不可重放判定都不受影响。
 *
 * 其余仍需确认的是：创建/关闭/删除店铺与标签页、任务创建/删除/运行、备份恢复、
 * 组织与模型绑定、插件与任务定义变更，以及 Job 闭环里的批准/驳回/取消。
 *
 * 放在 shared 而不是 Main：技能步骤校验（Main）与「技能可用工具」接口（面板表单的数据源）
 * 必须用同一份判定，否则表单会给出一个提交时才被拒的步骤。
 */
export const AGENT_CONFIRM_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  'closeStore', 'closeTab', 'createAgent', 'activateAgent', 'pauseAgent', 'resumeAgent', 'retireAgent',
  'createTask',
  'createStore', 'updateStore', 'archiveStore', 'restoreStore', 'deleteStorePermanent',
  'deleteTask', 'runTask', 'cancelTaskRun', 'restoreBackup',
  'createBookmark', 'deleteBookmark', 'deleteSkill',
  // Job 闭环里的判定类动作：批准/驳回等待人工确认的 Job、审阅结果、取消 Job。
  'approveJob', 'reviewJobResult', 'cancelJob',
  // 组织与权限：改岗位边界（店铺范围/工具权限/预算）与模型绑定。
  'updateAgent', 'bindAgentModel',
  // 插件与任务定义的可逆变更。
  'updatePlugin', 'deletePlugin', 'updateTask',
  // 把平台主体写进店铺营业执照（写库，且可能产生冲突需要人判断）。
  'applyEntity'
])

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
 * 路由用：能力探测结论是否够跑"必须输出 JSON"的智能体调用（2026-09-26 审计 P2-A）。
 *
 * 探测结果以前只落库、只显示，**不参与路由**：一个探测时完全没吐出文本（连通/对话失败）
 * 的 Profile 仍会被选中，然后在请求失败后才被发现，用户看到的是"智能体坏了"而不是"这个模型不可用"。
 *
 * 判定口径（为不误伤而刻意保守，实战验收校准过）：
 *   · **只有 `chat:false`（探测完全没有文本）才拦**——这是可靠的"这个 Profile 跑不了"信号；
 *   · `json:false` **不拦**，只回一条 warning：探测提示词只是一次弱信号（模型可能只是没按
 *     探针要求吐 JSON，实际带明确 schema 的请求照样能输出），拿它拦路由会把可用模型全部挡在门外
 *     （离线 fixture 与部分真实配置的探测结果就是 `json:false`，实测确实能跑通 Job）；
 *   · 从未探测（`{}`/缺字段）视为未知 → 放行。
 */
export function modelCapabilityVerdict(capabilities: unknown): { usable: boolean; code?: 'AGENT_MODEL_INCAPABLE'; reason?: string; warning?: string } {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return { usable: true }
  const record = capabilities as Record<string, unknown>
  if (record.chat === false) {
    return {
      usable: false,
      code: 'AGENT_MODEL_INCAPABLE',
      reason: '该模型 Profile 未通过对话能力探测（探测时完全没有返回文本），请到「设置 → 模型」重新测试或换一个 Profile'
    }
  }
  if (record.json === false) {
    return { usable: true, warning: '该模型 Profile 未通过 JSON 输出能力探测，若动作解析反复失败请重新测试或换一个 Profile' }
  }
  return { usable: true }
}

/**
 * 智能体回合输出：模型只允许返回 {"thought": "...", "reply": "...", "actions": [...]}。
 * thought 是一句简短的思考/理由摘要（可以展示给用户）；actions 逐条按闭合白名单校验，
 * 非法动作直接丢弃；返回 null 表示模型没按协议输出，调用方可以把原文当普通对话回复。
 */
export function parseAgentTurnOutput(raw: string, maxActions = 8): { thought: string; reply: string; actions: AgentSoftwareAction[] } | null {
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
  const limit = Math.max(0, Math.min(maxActions, 8))
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
