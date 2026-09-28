import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { logMain } from './logger'
import { getAiConfig } from './ai-client'
import { getAiKey } from './credential-store'
import { normalizeAiEndpoint } from '@shared/constants/ai'
import {
  agentBindingInputSchema,
  agentJobFeedbackSchema,
  agentJobActionSchema,
  agentJobCreateSchema,
  agentJobResultReviewSchema,
  agentJobListQuerySchema,
  agentOrgListQuerySchema,
  agentMemoryScopeSchema,
  agentRecordSchema,
  agentScopeSchema,
  agentTaskDelegateSchema,
  agentToolPolicySchema,
  modelCapabilitiesSchema,
  modelPricingSchema,
  modelProfileListQuerySchema,
  modelProfileInputSchema,
  modelProfileSchema,
  ROOT_AGENT_ID,
  type AgentJobCreate,
  type AgentJobFeedback,
  type AgentJobResultReview,
  type AgentRecord,
  type ModelProfile,
  type ModelProfileInput
} from '@shared/schemas/agent-domain'
import { redactAgentText } from '@shared/agent-privacy'
import { evaluateDailyBudget, type BudgetUsageSnapshot, type PricingLike } from '@shared/agent-budget'
import { dailyUsageSnapshot as governanceDailyUsageSnapshot, recordModelUsage } from './model-governance'
import { buildChatRequestBody, buildChatRequestHeaders, clampMaxOutputTokens } from './model-request'
import { canRetryModelRequest, canTransition, canUseFallback, deriveJobRisk, isMoneyActionText, MEMORY_SENSITIVE_RE, modelCapabilityVerdict, payloadHash as stablePayloadHash, selectExecutorAgent, stableJson as stableJsonValue } from '@shared/agent-domain-rules'
import { evaluateLeaseSweep } from '@shared/agent-lease'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import * as TaskStore from '../tasks/task-store'
import * as TaskRunner from '../tasks/task-runner'
import { getBrowserHostWindow, getOpenStoreIds, openStoreBrowser } from '../browser/window-manager'
import { compactAgentPrompt, compactSystemPrompt, estimateAgentTokens, readAgentContextUsage, resolveAgentContextBudget, resolveModelContextWindow, type AgentContextBudget, type AgentContextUsage } from '@shared/agent-context'
import { buildAgentJobSystemPrompt } from '@shared/agent-job-prompt'

export class AgentRuntimeError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AgentRuntimeError'
  }
}

const now = () => Date.now()
const json = (value: unknown): string => JSON.stringify(value ?? null)
const modelJobControllers = new Map<string, AbortController>()
function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

/**
 * Job 载荷清洗：字符串脱敏截断、数组/对象限宽。
 *
 * 嵌套层级：**16 层**（原为 6 层，会把 `loop → steps → input` 这类真实任务载荷
 * 在第 6 层替换成字符串，导致引擎校验报 "Expected object, received string"——
 * 真机实测：达人邀约经 Agent 派单必失败，面板直建却正常）。超限时**如实报错**，
 * 不做静默替换（静默替换会把结构字段变成字符串，是最难查的一类损坏）。
 */
function sanitizeJobValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactAgentText(value, 4000)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (depth >= 16) throw new AgentRuntimeError('AGENT_JOB_PAYLOAD_TOO_DEEP', 'Job 载荷嵌套层级超过上限（16 层）')
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeJobValue(item, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [redactAgentText(key, 100), sanitizeJobValue(item, depth + 1)]))
  }
  return null
}

/** Stable JSON is used for idempotency and immutable Job snapshots. */
export function stableJson(value: unknown): string {
  return stableJsonValue(value)
}

export function payloadHash(value: unknown): string {
  return stablePayloadHash(value)
}

function profileCredentialKey(profileId: string): string { return `agent_model_cred.${profileId}` }

/**
 * The legacy AI settings are the dedicated configuration for root-ceo.  Keep
 * the id stable because existing databases and acceptance fixtures already
 * reference it, but never treat the legacy agents.model_profile_id column as
 * authoritative.
 */
export const MAIN_AGENT_PROFILE_ID = 'model_default-main'

function assertModelEndpoint(endpoint: string): void {
  let parsed: URL
  try { parsed = new URL(endpoint) } catch { throw new AgentRuntimeError('AGENT_INVALID_INPUT', '模型接口 URL 无效') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '模型接口不能把凭据放在 URL 用户信息、查询参数或 hash 中')
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) return
  throw new AgentRuntimeError('AGENT_INVALID_INPUT', '模型接口必须使用 https://；仅允许本机回环地址使用 http://')
}

function setProfileKey(profileId: string, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MODEL_KEY_STORAGE_UNAVAILABLE', '系统安全存储不可用，拒绝保存模型 API Key')
  const encrypted = safeStorage.encryptString(key).toString('base64')
  getDatabase().prepare(`
    INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `).run(profileCredentialKey(profileId), `enc:${encrypted}`, now())
}

function clearProfileKey(profileId: string): void {
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(profileCredentialKey(profileId))
}

function profileHasKey(row: any): boolean {
  const ref = String(row.credential_ref || '')
  if (ref === 'ai_cred.key') return !!getAiKey()
  if (!ref) return false
  const stored = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(ref) as any
  return typeof stored?.value_json === 'string' && stored.value_json.startsWith('enc:') && stored.value_json.length > 8
}

function mapProfile(row: any): ModelProfile {
  const pricing = modelPricingSchema.nullable().safeParse(parseJson(row.pricing_json, null))
  const contextWindowTokens = row.context_window_tokens == null ? null : Number(row.context_window_tokens)
  // 回传实际生效的窗口与来源：界面据此显示“按多大窗口在跑”，也是 CDP 验收能断言的对象。
  const resolvedWindow = resolveModelContextWindow(String(row.provider || ''), String(row.model || ''), contextWindowTokens)
  return modelProfileSchema.parse({
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    model: row.model,
    hasKey: profileHasKey(row),
    temperature: Number(row.temperature),
    maxTokens: Number(row.max_tokens),
    contextWindowTokens,
    resolvedContextWindowTokens: resolvedWindow.tokens,
    resolvedContextSource: resolvedWindow.source,
    timeoutMs: Number(row.timeout_ms),
    fallbackProfileId: row.fallback_profile_id || null,
    capabilities: modelCapabilitiesSchema.parse(parseJson(row.capabilities_json, {})),
    concurrencyLimit: Number(row.concurrency_limit),
    dailyBudget: row.daily_budget_json ? parseJson(row.daily_budget_json, null) : null,
    pricing: pricing.success ? pricing.data : null,
    enabled: !!row.enabled,
    health: ['unknown', 'healthy', 'degraded', 'disabled'].includes(String(row.health)) ? row.health : 'unknown',
    updatedAt: Number(row.updated_at)
  })
}

function mapAgent(row: any): AgentRecord {
  const binding = getDatabase().prepare('SELECT model_profile_id FROM agent_model_bindings WHERE agent_id = ?').get(row.id) as any
  return agentRecordSchema.parse({
    id: row.id,
    parentId: row.parent_id || null,
    name: row.name,
    role: row.role,
    description: row.description,
    status: row.status,
    promptVersion: row.prompt_version,
    // agent_model_bindings is the only authoritative binding. The legacy
    // agents.model_profile_id column is maintained as a compatibility cache
    // but must never become a fallback source of truth.
    modelProfileId: binding?.model_profile_id || null,
    toolPolicy: agentToolPolicySchema.parse(parseJson(row.tool_policy_json, {})),
    storeScope: agentScopeSchema.parse(parseJson(row.store_scope_json, {})),
    memoryScope: agentMemoryScopeSchema.parse(parseJson(row.memory_scope_json, {})),
    maxConcurrency: Number(row.max_concurrency),
    dailyBudget: row.daily_budget_json ? parseJson(row.daily_budget_json, null) : null,
    timeoutMs: Number(row.timeout_ms),
    successCriteria: parseJson(row.success_criteria_json, []),
    createdByAgentId: row.created_by_agent_id || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    retiredAt: row.retired_at == null ? null : Number(row.retired_at)
  })
}

export type EffectiveAgentModel = {
  profileId: string | null
  profile: ModelProfile | null
  inherited: boolean
  sourceAgentId: string | null
}

/**
 * Resolve the model that Main must use for an Agent operation.
 *
 * A child with an explicit agent_model_bindings row owns that binding.  A
 * child without one inherits the current root-ceo binding, which is kept in
 * sync with the separate legacy AI configuration.  The resolved Profile is
 * only used at execution/snapshot time; the child binding remains null so the
 * database still distinguishes an explicit choice from inheritance.
 */
export function resolveEffectiveAgentModel(agentId: string): EffectiveAgentModel {
  const agent = requireAgent(agentId)
  let profileId = agent.modelProfileId
  let inherited = false
  let sourceAgentId: string | null = profileId ? agent.id : null

  if (!profileId) {
    inherited = true
    const root = agent.id === ROOT_AGENT_ID ? agent : requireAgent(ROOT_AGENT_ID)
    profileId = root.modelProfileId || MAIN_AGENT_PROFILE_ID
    sourceAgentId = root.modelProfileId ? ROOT_AGENT_ID : null
  }

  const profile = profileId
    ? listModelProfiles().find(item => item.id === profileId && item.enabled) || null
    : null
  return { profileId: profile?.id || profileId || null, profile, inherited, sourceAgentId }
}

/**
 * Return the effective context budget for a live Agent binding.  Callers use
 * this before constructing prompts so history, memory and output reservation
 * follow the selected model rather than a global character constant.
 */
export function getAgentContextBudget(agentId: string, requestedOutputTokens = 1200): AgentContextBudget {
  const resolved = resolveEffectiveAgentModel(agentId)
  if (!resolved.profile) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', 'Agent 尚未绑定可用模型 Profile')
  return resolveAgentContextBudget({
    provider: resolved.profile.provider,
    model: resolved.profile.model,
    contextWindowTokens: resolved.profile.contextWindowTokens,
    requestedOutputTokens,
    profileMaxTokens: resolved.profile.maxTokens
  })
}

function requireAgent(id: string): AgentRecord {
  const row = getDatabase().prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
  if (!row) throw new AgentRuntimeError('AGENT_NOT_FOUND', 'Agent 不存在')
  return mapAgent(row)
}

function requireRoot(actorId: string): AgentRecord {
  const actor = requireAgent(actorId)
  if (actor.id !== ROOT_AGENT_ID || actor.status !== 'active') throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '只有 active root-ceo 可以管理组织、模型和 Job')
  return actor
}

function getSettingNumber(key: string, fallback: number, min: number, max: number): number {
  const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as any
  const value = Number(row?.value_json)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
}

function deriveRisk(input: AgentJobCreate): 'read' | 'write' | 'submit' {
  return deriveJobRisk(input)
}

function assertStoreScope(agent: AgentRecord, storeId: string | null): void {
  if (!storeId) return
  const allowed = agent.storeScope.storeIds
  if (allowed.length && !allowed.includes(storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有访问该店铺的权限')
}

function assertAgentCanCreateJob(actor: AgentRecord, assigned: AgentRecord, input: AgentJobCreate, risk: string, moneyConfirmationSatisfied = false): void {
  if (assigned.id === ROOT_AGENT_ID) throw new AgentRuntimeError('AGENT_ROOT_CANNOT_EXECUTE', '主 Agent 只负责对话、拆分和派单，不执行任务；需要执行的任务必须派给子 Agent')
  if (actor.id !== ROOT_AGENT_ID && !actor.toolPolicy.tools.includes('create_job')) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有派发 Job 的权限')
  const money = isMoneyActionText({ goal: input.goal, inputSummary: input.inputSummary, browserTask: input.browserTask })
  // 自治运营策略：非资金任务不需要审批；只有资金动作必须保留人工确认。
  //
  // 唯一例外：用户自己在对话里发起的**只读采集**（`moneyConfirmationSatisfied`）。
  // 采集目标里常出现「退款金额」「订单明细」等词，会被资金文案规则误判；把它卡在等待确认里
  // 只会让用户点了采集却什么也没发生。豁免只能由 Main 内部调用方显式传入——
  // `agentTaskDelegateSchema`/`agentJobCreateSchema` 都是 `.strict()`，渲染层塞不进这个字段。
  // （2026-09-26 审计 P0-2：此前这里是"先按要求确认、再用 Job 自己的 confirmationId 自批"，等于走过场。）
  if (money && !input.requiresConfirmation && !moneyConfirmationSatisfied) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '涉及资金的动作必须保留人工确认')
  if (['paused', 'retired'].includes(assigned.status)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '暂停或退休 Agent 不能接收新 Job')
  if (assigned.status === 'probation' && (risk !== 'read' || input.requiresConfirmation)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', 'probation Agent 只能执行无副作用的只读试用 Job')
  // storeScope.readOnly 是权限模型的一部分（§4.2/§4.3）：只读范围的 Agent 不能接收会碰店铺的写/提交类 Job。
  // 纯模型 Job（browserTask 为空）不接触店铺，风险词只来自目标文案，不受只读范围限制。
  if (assigned.storeScope.readOnly && input.browserTask && risk !== 'read') throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '该 Agent 的店铺范围是只读，不能接收写操作 Job；需要写操作请在 Agent 团队里关闭它的“只读范围”')
  assertStoreScope(actor, input.storeId)
  assertStoreScope(assigned, input.storeId)
}

function snapshotForJob(actor: AgentRecord, assigned: AgentRecord, profile: ModelProfile | null, modelSource: 'bound' | 'inherited' | 'none' = 'none'): Record<string, unknown> {
  const fallback = profile?.fallbackProfileId ? listModelProfiles().find(item => item.id === profile.fallbackProfileId && item.enabled) || null : null
  const snapshotProfile = (item: ModelProfile | null) => item ? {
    id: item.id, name: item.name, provider: item.provider, endpoint: item.endpoint, model: item.model,
    fallbackProfileId: item.fallbackProfileId, temperature: item.temperature, maxTokens: item.maxTokens,
    contextWindowTokens: item.contextWindowTokens,
    timeoutMs: item.timeoutMs, dailyBudget: item.dailyBudget, pricing: item.pricing, concurrencyLimit: item.concurrencyLimit,
    capabilities: item.capabilities, enabled: item.enabled
  } : null
  return {
    actorId: actor.id,
    assignedAgentId: assigned.id,
    toolPolicy: assigned.toolPolicy,
    storeScope: assigned.storeScope,
    memoryScope: assigned.memoryScope,
    maxConcurrency: assigned.maxConcurrency,
    dailyBudget: assigned.dailyBudget,
    modelSource,
    modelProfile: snapshotProfile(profile),
    fallbackProfile: snapshotProfile(fallback),
    capturedAt: now()
  }
}

function jobPermissionSnapshotChanged(row: any, assigned: AgentRecord): boolean {
  const snapshot = parseJson<any>(row.permission_snapshot_json, null)
  if (!snapshot || snapshot.assignedAgentId !== assigned.id) return true
  return stableJsonValue(snapshot.toolPolicy) !== stableJsonValue(assigned.toolPolicy)
    || stableJsonValue(snapshot.storeScope) !== stableJsonValue(assigned.storeScope)
    || stableJsonValue(snapshot.memoryScope) !== stableJsonValue(assigned.memoryScope)
    || Number(snapshot.maxConcurrency) !== Number(assigned.maxConcurrency)
    || stableJsonValue(snapshot.dailyBudget ?? null) !== stableJsonValue(assigned.dailyBudget ?? null)
}

export function ensureAgentRuntimeBootstrap(): void {
  const db = getDatabase()
  const t = now()
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(ROOT_AGENT_ID)
  db.transaction(() => {
    if (!existing) {
      db.prepare(`INSERT INTO agents(id,parent_id,name,role,description,status,prompt_version,model_profile_id,tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ROOT_AGENT_ID, null, 'ShopPilot CEO', 'ceo', '唯一主 Agent：经营决策、拆解、派单、审核和记忆治理', 'active', 'ceo-v1', null,
        json(agentToolPolicySchema.parse({ canCreateAgent: true, canChangeModel: true, canChangePolicy: true, canReadOtherAgentPrivateMemory: true, tools: ['observe_page', 'read_text', 'read_table', 'model_analyze', 'create_job', 'review_job', 'memory_search', 'memory_write'] })),
        json(agentScopeSchema.parse({ storeIds: [], readOnly: false })),
        json(agentMemoryScopeSchema.parse({ agentIds: [ROOT_AGENT_ID], includeShared: true, write: true })),
        json(['Job 有明确目标、权限、证据和审核结论']), 4, null, 120000, null, t, t
      )
    } else {
      // Root identity is immutable; only repair a missing status after a
      // partial migration. Never rename or replace the root row.
      db.prepare("UPDATE agents SET status='active', parent_id=NULL, role='ceo', updated_at=? WHERE id=?").run(t, ROOT_AGENT_ID)
    }
  })()

  const cfg = getAiConfig()
  let profile = db.prepare('SELECT * FROM agent_model_profiles WHERE id = ?').get(MAIN_AGENT_PROFILE_ID) as any
  if (!profile) {
    const endpoint = normalizeAiEndpoint(cfg.endpoint)
    db.prepare(`INSERT INTO agent_model_profiles(id,name,provider,endpoint,model,credential_ref,temperature,max_tokens,timeout_ms,fallback_profile_id,capabilities_json,concurrency_limit,daily_budget_json,enabled,health,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      MAIN_AGENT_PROFILE_ID, '主 Agent AI 配置', 'openai-compatible', endpoint, cfg.model, 'ai_cred.key', 0.7, 1200, cfg.timeoutMs, null,
      json({ chat: true, json: true, vision: false, cancellation: true }), 1, null, 1, 'unknown', t, t
    )
    profile = db.prepare('SELECT * FROM agent_model_profiles WHERE id = ?').get(MAIN_AGENT_PROFILE_ID) as any
  } else {
    // The dedicated root-ceo configuration is still backed by the existing
    // AI settings.  Sync only the non-secret connection fields; the key stays
    // in the legacy safeStorage credential and is never copied to SQLite.
    db.prepare('UPDATE agent_model_profiles SET name=?,provider=?,endpoint=?,model=?,credential_ref=?,timeout_ms=?,enabled=1,updated_at=? WHERE id=?').run(
      '主 Agent AI 配置', 'openai-compatible', normalizeAiEndpoint(cfg.endpoint), cfg.model, 'ai_cred.key', cfg.timeoutMs, t, MAIN_AGENT_PROFILE_ID
    )
    profile = db.prepare('SELECT * FROM agent_model_profiles WHERE id = ?').get(MAIN_AGENT_PROFILE_ID) as any
  }
  db.prepare(`INSERT INTO agent_model_bindings(agent_id,model_profile_id,updated_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET model_profile_id=excluded.model_profile_id,updated_at=excluded.updated_at`).run(ROOT_AGENT_ID, profile.id, t)
  db.prepare('UPDATE agents SET model_profile_id = ?, updated_at = ? WHERE id = ?').run(profile.id, t, ROOT_AGENT_ID)
  writeAudit('agent.bootstrap', 'success', { actor: ROOT_AGENT_ID, requestId: `migration-${profile.id}` })
}

/** Keep the root-ceo Profile aligned after the user edits Settings → AI. */
export function syncMainAgentProfileFromAiConfig(): void {
  const db = getDatabase()
  const cfg = getAiConfig()
  const t = now()
  const existing = db.prepare('SELECT id FROM agent_model_profiles WHERE id=?').get(MAIN_AGENT_PROFILE_ID)
  if (!existing) return
  db.prepare('UPDATE agent_model_profiles SET name=?,provider=?,endpoint=?,model=?,credential_ref=?,timeout_ms=?,enabled=1,updated_at=? WHERE id=?').run(
    '主 Agent AI 配置', 'openai-compatible', normalizeAiEndpoint(cfg.endpoint), cfg.model, 'ai_cred.key', cfg.timeoutMs, t, MAIN_AGENT_PROFILE_ID
  )
}

/**
 * Recent Job summaries for the visible Agent's software context. Only bounded,
 * redacted fields leave Main; no prompts, memory bodies or credentials.
 */
export function listRecentAgentJobSummaries(limit = 20): Array<{ id: string; goal: string; status: string; assignedAgentId: string; risk: string; resultCount: number; unapprovedCount: number; createdAt: number }> {
  const bounded = Math.min(50, Math.max(1, Math.floor(limit)))
  const rows = getDatabase().prepare(`SELECT j.id, j.goal, j.status, j.assigned_agent_id, j.risk, j.created_at,
      (SELECT COUNT(*) FROM agent_job_results r WHERE r.job_id = j.id) AS result_count,
      (SELECT COUNT(*) FROM agent_job_results r WHERE r.job_id = j.id AND r.approved = 0) AS unapproved_count
    FROM agent_jobs j ORDER BY j.created_at DESC LIMIT ?`).all(bounded) as any[]
  return rows.map(row => ({
    id: String(row.id),
    goal: redactAgentText(String(row.goal || ''), 200),
    status: String(row.status),
    assignedAgentId: String(row.assigned_agent_id),
    risk: String(row.risk || 'read'),
    resultCount: Number(row.result_count || 0),
    unapprovedCount: Number(row.unapproved_count || 0),
    createdAt: Number(row.created_at)
  }))
}

export function listAgents(): AgentRecord[] {
  return (getDatabase().prepare('SELECT * FROM agents ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, created_at ASC').all(ROOT_AGENT_ID) as any[]).map(mapAgent)
}

export function listAgentsPage(raw: unknown = {}): { items: AgentRecord[]; nextCursor: string | null; hasMore: boolean } {
  const query = agentOrgListQuerySchema.parse(raw)
  const rankExpr = "CASE WHEN id='root-ceo' THEN 0 ELSE 1 END"
  const params: unknown[] = []
  const where: string[] = []
  if (query.cursor) {
    const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|')
    if (decoded.length === 3) {
      const rank = Number(decoded[0]); const createdAt = Number(decoded[1]); const id = decoded[2]
      if (Number.isFinite(rank) && Number.isFinite(createdAt) && id) {
        where.push(`(${rankExpr} > ? OR (${rankExpr} = ? AND (created_at > ? OR (created_at = ? AND id > ?))))`)
        params.push(rank, rank, createdAt, createdAt, id)
      }
    }
  }
  params.push(query.limit + 1)
  const rows = getDatabase().prepare(`SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${rankExpr}, created_at ASC, id ASC LIMIT ?`).all(...params) as any[]
  const hasMore = rows.length > query.limit
  const items = rows.slice(0, query.limit).map(mapAgent)
  const last = rows[query.limit - 1]
  const nextCursor = hasMore && last
    ? Buffer.from(`${last.id === ROOT_AGENT_ID ? 0 : 1}|${last.created_at}|${last.id}`).toString('base64url')
    : null
  return { items, nextCursor, hasMore }
}

export function getAgent(id: string): AgentRecord { return requireAgent(id) }

export function createAgent(input: {
  actorAgentId: string; confirmed: boolean; name: string; role: string; description: string;
  modelProfileId?: string | null; storeScope?: unknown; memoryScope?: unknown; maxConcurrency?: number;
  dailyBudget?: unknown; timeoutMs?: number; successCriteria?: string[]; toolPolicy?: unknown
}): AgentRecord {
  requireRoot(input.actorAgentId)
  if (!input.confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '创建 probation Agent 需要用户确认岗位、权限和预算')
  const role = String(input.role) as any
  if (!['operator', 'reviewer', 'analyst', 'content', 'support'].includes(role)) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '子 Agent 岗位不合法')
  const modelProfileId = input.modelProfileId ?? null
  if (modelProfileId && !getDatabase().prepare('SELECT id FROM agent_model_profiles WHERE id=? AND enabled=1').get(modelProfileId)) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', '模型 Profile 不存在或已停用')
  const id = `agent_${randomUUID()}`
  const storeScope = agentScopeSchema.parse(input.storeScope ?? {})
  const memoryScope = agentMemoryScopeSchema.parse({ ...(input.memoryScope as any || {}), agentIds: [id] })
  const defaultTools = role === 'reviewer' ? ['observe_page', 'read_text', 'read_table', 'review_job', 'memory_search'] : ['observe_page', 'read_text', 'read_table', 'model_analyze', 'memory_search']
  const toolPolicy = agentToolPolicySchema.parse({ ...(input.toolPolicy as any || {}), tools: (input.toolPolicy as any)?.tools ?? defaultTools })
  if (toolPolicy.canUseShell || toolPolicy.canReadCredentials || toolPolicy.canCreateAgent || toolPolicy.canChangeModel || toolPolicy.canChangePolicy || toolPolicy.canReadOtherAgentPrivateMemory) {
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '子 Agent 不能获得 Shell、凭据、组织、模型或其他 Agent 私有记忆权限')
  }
  const t = now()
  getDatabase().prepare(`INSERT INTO agents(id,parent_id,name,role,description,status,prompt_version,model_profile_id,tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, ROOT_AGENT_ID, redactAgentText(input.name, 120), role, redactAgentText(input.description, 1000), 'probation', 'operator-v1', modelProfileId,
    json(toolPolicy),
    json(storeScope), json(memoryScope), json(input.successCriteria ?? ['只读试用任务有可核验证据']), Math.min(32, Math.max(1, Math.floor(input.maxConcurrency ?? 1))), input.dailyBudget == null ? null : json(input.dailyBudget), Math.min(3600000, Math.max(1000, Math.floor(input.timeoutMs ?? 120000))), ROOT_AGENT_ID, t, t
  )
  if (modelProfileId) bindAgentModel({ agentId: id, modelProfileId, actorAgentId: ROOT_AGENT_ID })
  writeAudit('agent.org.create', 'success', { actor: ROOT_AGENT_ID, requestId: id })
  return requireAgent(id)
}

export function updateAgent(input: { actorAgentId: string; agentId: string; name?: string; description?: string; storeScope?: unknown; memoryScope?: unknown; maxConcurrency?: number; dailyBudget?: unknown; timeoutMs?: number; toolPolicy?: unknown; confirmed?: boolean }): AgentRecord {
  requireRoot(input.actorAgentId)
  const agent = requireAgent(input.agentId)
  if (agent.id === ROOT_AGENT_ID && input.name && input.name !== agent.name) throw new AgentRuntimeError('AGENT_ROOT_IMMUTABLE', 'root-ceo 不能改名')
  const changingBoundary = input.storeScope !== undefined || input.memoryScope !== undefined || input.toolPolicy !== undefined
  if (changingBoundary && input.confirmed !== true) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '修改 Agent 能力、店铺范围或记忆范围需要用户确认')
  const updates: string[] = []
  const values: unknown[] = []
  if (input.name !== undefined) { updates.push('name=?'); values.push(redactAgentText(input.name, 120)) }
  if (input.description !== undefined) { updates.push('description=?'); values.push(redactAgentText(input.description, 1000)) }
  if (input.storeScope !== undefined) { updates.push('store_scope_json=?'); values.push(json(agentScopeSchema.parse(input.storeScope))) }
  if (input.memoryScope !== undefined) { updates.push('memory_scope_json=?'); values.push(json(agentMemoryScopeSchema.parse({ ...(input.memoryScope as any), agentIds: [agent.id] }))) }
  if (input.toolPolicy !== undefined) {
    const toolPolicy = agentToolPolicySchema.parse(input.toolPolicy)
    if (agent.id !== ROOT_AGENT_ID && (toolPolicy.canUseShell || toolPolicy.canReadCredentials || toolPolicy.canCreateAgent || toolPolicy.canChangeModel || toolPolicy.canChangePolicy || toolPolicy.canReadOtherAgentPrivateMemory)) {
      throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '子 Agent 不能获得 Shell、凭据、组织、模型或其他 Agent 私有记忆权限')
    }
    updates.push('tool_policy_json=?'); values.push(json(toolPolicy))
  }
  if (input.maxConcurrency !== undefined) { updates.push('max_concurrency=?'); values.push(Math.min(32, Math.max(1, Math.floor(input.maxConcurrency)))) }
  if (input.dailyBudget !== undefined) { updates.push('daily_budget_json=?'); values.push(input.dailyBudget == null ? null : json(input.dailyBudget)) }
  if (input.timeoutMs !== undefined) { updates.push('timeout_ms=?'); values.push(Math.min(3600000, Math.max(1000, Math.floor(input.timeoutMs)))) }
  if (updates.length) { values.push(now(), input.agentId); getDatabase().prepare(`UPDATE agents SET ${updates.join(',')}, updated_at=? WHERE id=?`).run(...values) }
  writeAudit('agent.org.update', 'success', { actor: input.actorAgentId, requestId: input.agentId })
  return requireAgent(input.agentId)
}

function transitionAgent(agentId: string, to: 'active' | 'paused' | 'retired', actorAgentId: string, confirmed: boolean): AgentRecord {
  requireRoot(actorAgentId)
  const agent = requireAgent(agentId)
  if (agent.id === ROOT_AGENT_ID) throw new AgentRuntimeError('AGENT_ROOT_IMMUTABLE', 'root-ceo 不能暂停、退休或再次激活')
  if (!confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '该组织变更需要用户确认')
  const allowed: Record<string, string[]> = { probation: ['active', 'paused', 'retired'], active: ['paused', 'retired'], paused: ['active', 'retired'], retired: [] }
  if (!allowed[agent.status]?.includes(to)) throw new AgentRuntimeError('AGENT_INVALID_STATE', `不允许 ${agent.status} -> ${to}`)
  const t = now()
  getDatabase().prepare('UPDATE agents SET status=?, retired_at=?, updated_at=? WHERE id=? AND status=?').run(to, to === 'retired' ? t : null, t, agentId, agent.status)
  writeAudit(`agent.org.${to}` as any, 'success', { actor: actorAgentId, requestId: agentId })
  return requireAgent(agentId)
}
export const activateAgent = (agentId: string, actorAgentId: string, confirmed: boolean) => transitionAgent(agentId, 'active', actorAgentId, confirmed)
export const pauseAgent = (agentId: string, actorAgentId: string, confirmed: boolean) => transitionAgent(agentId, 'paused', actorAgentId, confirmed)
export const resumeAgent = (agentId: string, actorAgentId: string, confirmed: boolean) => transitionAgent(agentId, 'active', actorAgentId, confirmed)
export const retireAgent = (agentId: string, actorAgentId: string, confirmed: boolean) => transitionAgent(agentId, 'retired', actorAgentId, confirmed)

const ROLE_TEMPLATES: Record<string, Record<string, unknown>> = {
  operator: { name: '商品运营', description: '只读分析商品标题、价格、库存和上下架状态', tools: ['observe_page', 'read_text', 'read_table', 'model_analyze'], successCriteria: ['每个结论引用页面证据'] },
  analyst: { name: '数据分析', description: '汇总店铺指标、趋势和异常', tools: ['observe_page', 'read_text', 'read_table', 'model_analyze'], successCriteria: ['指标与来源 Job 可追溯'] },
  reviewer: { name: '审核 Agent', description: '检查数据完整性、证据和风险', tools: ['observe_page', 'read_text', 'read_table', 'review_job'], successCriteria: ['没有证据的结论必须拒绝'] },
  content: { name: '内容文案', description: '生成草稿，不直接发布', tools: ['model_analyze', 'memory_search'], successCriteria: ['草稿明确标记为未发布'] },
  support: { name: '客服质检', description: '只读检查回复质量和漏答问题', tools: ['observe_page', 'read_text', 'read_table', 'model_analyze'], successCriteria: ['只读并保留样本证据'] }
}
export function previewHr(role: string, actorAgentId: string, mode: 'hr' = 'hr'): Record<string, unknown> {
  requireRoot(actorAgentId)
  if (mode !== 'hr') throw new AgentRuntimeError('AGENT_INVALID_INPUT', 'HR 只能使用 root-ceo 的 mode=hr')
  const t = ROLE_TEMPLATES[role] || ROLE_TEMPLATES.operator
  writeAudit('agent.hr.preview', 'success', { actor: actorAgentId, requestId: role })
  return { mode: 'hr', role, ...t, prohibitedTools: ['shell', 'credentials', 'publish', 'send', 'payment', 'delete', 'order', 'account_change'], statusOnCreate: 'probation', requiresUserConfirmation: true, maxConcurrency: 1, dailyBudget: { currency: 'USD', amount: 0 } }
}

export function listModelProfiles(): ModelProfile[] {
  return (getDatabase().prepare('SELECT * FROM agent_model_profiles ORDER BY updated_at DESC').all() as any[]).map(mapProfile)
}

export function listModelProfilesPage(raw: unknown = {}): { items: ModelProfile[]; nextCursor: string | null; hasMore: boolean } {
  const query = modelProfileListQuerySchema.parse(raw)
  const params: unknown[] = []
  const where: string[] = []
  if (query.enabled !== null) { where.push('enabled=?'); params.push(query.enabled ? 1 : 0) }
  if (query.cursor) {
    const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|')
    if (decoded.length === 2) {
      const updatedAt = Number(decoded[0]); const id = decoded[1]
      if (Number.isFinite(updatedAt) && id) {
        where.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
        params.push(updatedAt, updatedAt, id)
      }
    }
  }
  params.push(query.limit + 1)
  const rows = getDatabase().prepare(`SELECT * FROM agent_model_profiles ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...params) as any[]
  const hasMore = rows.length > query.limit
  const items = rows.slice(0, query.limit).map(mapProfile)
  const last = rows[query.limit - 1]
  const nextCursor = hasMore && last ? Buffer.from(`${last.updated_at}|${last.id}`).toString('base64url') : null
  return { items, nextCursor, hasMore }
}

type FallbackProfileRow = { id?: string; fallback_profile_id?: string | null; enabled?: number }

function assertFallbackProfileIsUsable(profileId: string, fallbackProfileId: string | null): void {
  if (!fallbackProfileId) return
  const db = getDatabase()
  const fallback = db.prepare('SELECT id,enabled FROM agent_model_profiles WHERE id=?').get(fallbackProfileId) as FallbackProfileRow | undefined
  if (!fallback || !fallback.enabled) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', '备用 Profile 不存在或已停用')
  const seen = new Set<string>([profileId])
  let currentId: string | null = fallbackProfileId
  // A fallback graph is intentionally bounded to a short chain.  The runtime
  // currently consumes one fallback, but rejecting a cycle here also keeps
  // future multi-hop routing from looping or silently retrying forever.
  for (let depth = 0; currentId && depth < 64; depth++) {
    if (seen.has(currentId)) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '备用 Profile 不能形成循环')
    seen.add(currentId)
    const row = db.prepare('SELECT fallback_profile_id,enabled FROM agent_model_profiles WHERE id=?').get(currentId) as FallbackProfileRow | undefined
    if (!row || !row.enabled) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', '备用 Profile 不存在或已停用')
    currentId = row.fallback_profile_id ? String(row.fallback_profile_id) : null
  }
  if (currentId) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '备用 Profile 链超过最大深度')
}

export function setModelProfile(raw: ModelProfileInput, actorAgentId: string): ModelProfile {
  requireRoot(actorAgentId)
  const input = modelProfileInputSchema.parse(raw)
  assertModelEndpoint(input.endpoint)
  const id = input.id || `model_${randomUUID()}`
  const existing = getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=?').get(id) as any
  if (input.fallbackProfileId === id) throw new AgentRuntimeError('AGENT_INVALID_INPUT', 'fallback Profile 不能指向自身')
  assertFallbackProfileIsUsable(id, input.fallbackProfileId)
  const t = now()
  // A key explicitly entered in the Agent Profile editor must belong to that
  // Profile.  The migrated default-main row may still point at the legacy
  // ai_cred.key; keeping that reference when a new key is supplied would make
  // hasKey/model execution read the unrelated legacy credential instead of the
  // value the user just saved.
  if (id === MAIN_AGENT_PROFILE_ID && (input.apiKey || input.clearKey)) {
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '主 Agent 的 API Key 只能在“设置 → AI 配置”中管理')
  }
  const credentialRef = id === MAIN_AGENT_PROFILE_ID
    ? 'ai_cred.key'
    : (input.apiKey || input.clearKey)
    ? profileCredentialKey(id)
    : (existing?.credential_ref || null)
  getDatabase().prepare(`INSERT INTO agent_model_profiles(id,name,provider,endpoint,model,credential_ref,temperature,max_tokens,context_window_tokens,timeout_ms,fallback_profile_id,capabilities_json,concurrency_limit,daily_budget_json,pricing_json,enabled,health,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,endpoint=excluded.endpoint,model=excluded.model,temperature=excluded.temperature,max_tokens=excluded.max_tokens,context_window_tokens=excluded.context_window_tokens,timeout_ms=excluded.timeout_ms,fallback_profile_id=excluded.fallback_profile_id,capabilities_json=excluded.capabilities_json,concurrency_limit=excluded.concurrency_limit,daily_budget_json=excluded.daily_budget_json,pricing_json=excluded.pricing_json,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(
    id, input.name, input.provider, normalizeAiEndpoint(input.endpoint), input.model, credentialRef, input.temperature, input.maxTokens, input.contextWindowTokens, input.timeoutMs, input.fallbackProfileId,
    json(input.capabilities), input.concurrencyLimit, input.dailyBudget == null ? null : json(input.dailyBudget), input.pricing == null ? null : json(input.pricing), input.enabled ? 1 : 0, existing?.health || 'unknown', existing?.created_at || t, t
  )
  if (input.apiKey) setProfileKey(id, input.apiKey)
  if (input.clearKey) clearProfileKey(id)
  writeAudit(existing ? 'agent.model.update' : 'agent.model.create', 'success', { actor: actorAgentId, requestId: id })
  return mapProfile(getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=?').get(id))
}

export function deleteModelProfile(profileId: string, actorAgentId: string): void {
  requireRoot(actorAgentId)
  if (profileId === MAIN_AGENT_PROFILE_ID) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '主 Agent AI 配置不能删除')
  if (getDatabase().prepare('SELECT 1 FROM agent_model_bindings WHERE model_profile_id=?').get(profileId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '仍有 Agent 绑定该 Profile，不能删除')
  getDatabase().prepare('DELETE FROM agent_model_profiles WHERE id=?').run(profileId)
  clearProfileKey(profileId)
  writeAudit('agent.model.delete', 'success', { actor: actorAgentId, requestId: profileId })
}

export function bindAgentModel(input: { agentId: string; modelProfileId: string | null; actorAgentId: string }): AgentRecord {
  requireRoot(input.actorAgentId)
  const agent = requireAgent(input.agentId)
  if (agent.id === ROOT_AGENT_ID && !input.modelProfileId) {
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '主 Agent 必须使用“设置 → AI 配置”中的模型')
  }
  if (agent.id === ROOT_AGENT_ID && input.modelProfileId !== MAIN_AGENT_PROFILE_ID) {
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '主 Agent 的模型由“设置 → AI 配置”管理')
  }
  if (input.modelProfileId) {
    const profile = getDatabase().prepare('SELECT id FROM agent_model_profiles WHERE id=? AND enabled=1').get(input.modelProfileId)
    if (!profile) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', '模型 Profile 不存在或已停用')
  }
  const t = now()
  getDatabase().transaction(() => {
    if (input.modelProfileId) {
      getDatabase().prepare('INSERT INTO agent_model_bindings(agent_id,model_profile_id,updated_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET model_profile_id=excluded.model_profile_id,updated_at=excluded.updated_at').run(agent.id, input.modelProfileId, t)
    } else {
      getDatabase().prepare('DELETE FROM agent_model_bindings WHERE agent_id=?').run(agent.id)
    }
    getDatabase().prepare('UPDATE agents SET model_profile_id=?,updated_at=? WHERE id=?').run(input.modelProfileId, t, agent.id)
  })()
  writeAudit(input.modelProfileId ? 'agent.model.bind' : 'agent.model.unbind', 'success', { actor: input.actorAgentId, requestId: `${agent.id}:${input.modelProfileId || 'inherit-main'}` })
  return requireAgent(agent.id)
}

function getProfileSecret(profile: any): string | null {
  if (profile.credential_ref === 'ai_cred.key') return getAiKey()
  if (!profile.credential_ref || !safeStorage.isEncryptionAvailable()) return null
  const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get(profile.credential_ref) as any
  if (!String(row?.value_json || '').startsWith('enc:')) return null
  try { return safeStorage.decryptString(Buffer.from(String(row.value_json).slice(4), 'base64')) } catch { return null }
}

/** 用量写入后通知 UI（§10 EVENT_CHANNELS.AGENT_USAGE_UPDATED）。 */
function emitUsageUpdated(agentId: string, profileId: string | null, status: string): void {
  try { getBrowserHostWindow()?.webContents.send(EVENT_CHANNELS.AGENT_USAGE_UPDATED, { agentId, profileId, status }) } catch { /* UI event is best effort */ }
}

/** 聊天/回合的日预算硬阻断：与 Job 链路同一口径（tokens 预算按当日该 Agent 用量合计）。 */
/**
 * 当日用量快照与记账都已收敛到 services/model-governance.ts（审计 P1）：
 * legacy AI 栈（测试连接/邀约话术）与 Agent 链路现在写同一张表、用同一套口径。
 */
function dailyUsageSnapshot(agentId: string): BudgetUsageSnapshot {
  return governanceDailyUsageSnapshot(agentId)
}

/**
 * 日预算判定统一入口（§27）。
 *
 * 判定本身在 `@shared/agent-budget` 的纯函数里（可单测），这里只负责查用量、拿单价、抛错。
 * 关键口径修正（2026-09-26 审计）：非 tokens 货币的预算**不再静默不生效**——
 * Profile 配了同币种单价就按估算成本比较，没配就明确报 AGENT_BUDGET_UNENFORCEABLE；
 * 并把本次请求的最大输出（max_tokens）作为**预留**计入，避免单次调用越过日上限。
 */
function assertDailyBudget(input: {
  agentId: string
  budgets: Array<{ scope: 'agent' | 'profile'; currency?: string | null; amount: number }>
  pricing: PricingLike | null
  reserve?: { inputTokens?: number; outputTokens?: number }
}): void {
  const verdict = evaluateDailyBudget({
    budgets: input.budgets,
    usage: dailyUsageSnapshot(input.agentId),
    pricing: input.pricing,
    reserve: input.reserve
  })
  if (verdict.blocked) throw new AgentRuntimeError(verdict.code || 'AGENT_BUDGET_BLOCKED', verdict.message || '达到日预算边界')
}

function assertChatBudget(agentId: string, profile: any, reserveTokens = 0): void {
  let agentBudget: any = null
  try { agentBudget = getAgent(agentId).dailyBudget } catch { /* Agent 缺失时只按 Profile 预算 */ }
  const profileBudget = profile?.daily_budget_json ? parseJson<any>(profile.daily_budget_json, null) : null
  const budgets: Array<{ scope: 'agent' | 'profile'; currency?: string | null; amount: number }> = []
  if (agentBudget && typeof agentBudget.amount === 'number') budgets.push({ scope: 'agent', currency: agentBudget.currency, amount: Number(agentBudget.amount) })
  if (profileBudget && typeof profileBudget.amount === 'number') budgets.push({ scope: 'profile', currency: profileBudget.currency, amount: Number(profileBudget.amount) })
  if (!budgets.length) return
  const parsedPricing = modelPricingSchema.nullable().safeParse(parseJson(profile?.pricing_json, null))
  const pricing = parsedPricing.success ? parsedPricing.data : null
  assertDailyBudget({ agentId, budgets, pricing, reserve: { outputTokens: Math.max(0, Number(reserveTokens) || 0) } })
}

/** 记录一次聊天/回合的模型用量（§7.3 要求所有模型调用可计量；失败也留痕）。 */
function recordChatUsage(agentId: string, profileId: string | null, parsed: any, status: 'succeeded' | 'failed', errorCode?: string | null): void {
  recordModelUsage({
    agentId,
    profileId,
    parsed,
    status,
    errorCode: errorCode || null,
    onRecorded: (id, pid, state) => emitUsageUpdated(id, pid, state)
  })
}

/** Main-only chat path for the visible root-ceo Agent. It resolves the model
 * through agent_model_bindings instead of the legacy global AI settings.
 * 与 Job 链路一致：网络/429 只重试一次；主模型失败且配置了备用 Profile 时按白名单降级一次；
 * 每次调用都写 agent_usage（§7.3）。 */
export async function chatCompleteForAgent(agentId: string, opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<{ text: string; model: string; elapsedMs: number; profileId: string; fallbackUsed: boolean; usage: AgentContextUsage }> {
  const resolved = resolveEffectiveAgentModel(agentId)
  const profileId = resolved.profileId
  if (!profileId) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', 'Agent 尚未绑定模型 Profile')
  const primary = getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(profileId) as any
  if (!primary) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', 'Agent 绑定的模型 Profile 不存在或已停用')
  assertChatBudget(agentId, primary, Math.max(0, Number(opts.maxTokens ?? primary.max_tokens ?? 0)))
  const fallback = primary.fallback_profile_id
    ? getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(primary.fallback_profile_id) as any
    : null
  const rawCandidates: any[] = fallback && fallback.id !== primary.id ? [primary, fallback] : [primary]
  // 能力探测结论参与路由（审计 P2-A）：明确探出 chat/json 不可用的 Profile 不再被选中，
  // 否则智能体回合只会在解析动作时报"模型没返回可解析 JSON"，用户看不出是模型能力问题。
  const incapable: string[] = []
  const candidates = rawCandidates.filter(profile => {
    const verdict = modelCapabilityVerdict(parseJson((profile as any).capabilities_json, {}))
    if (verdict.warning) logMain('warn', `[agent] 模型 Profile 能力探测提示 profile=${profile.id} warning=${verdict.warning}`)
    if (verdict.usable) return true
    incapable.push(`${profile.name || profile.id}：${verdict.reason || '能力探测未通过'}`)
    // 主 Profile 不可用时降级到备用 Profile 是明确的配置降级，记一条 warn 留痕
    logMain('warn', `[agent] 跳过能力探测未通过的模型 Profile profile=${profile.id} reason=${verdict.code}`)
    return false
  })
  if (!candidates.length) {
    throw new AgentRuntimeError('AGENT_MODEL_INCAPABLE', incapable.join('；') || '绑定的模型 Profile 未通过能力探测')
  }
  let lastError: any = null
  for (let index = 0; index < candidates.length; index++) {
    const profile = candidates[index]
    // 按身份而不是下标判断是不是备用 Profile：主 Profile 可能已被能力探测过滤掉
    const isFallback = String(profile.id) !== String(primary.id)
    const key = getProfileSecret(profile)
    if (!key) {
      lastError = new AgentRuntimeError('AGENT_MODEL_KEY_REQUIRED', '该模型 Profile 尚未配置 API Key')
      if (!isFallback) continue
      throw lastError
    }
    try {
      const result = await requestChatCompletion(profile, key, opts)
      recordChatUsage(agentId, String(profile.id), result.parsed, 'succeeded', null)
      if (isFallback) logMain('warn', `[agent] 聊天主模型失败后按白名单切换备用 Profile profile=${profile.id}`)
      const usage = readAgentContextUsage(result.parsed, result.contextWindowTokens, result.maxInputTokens)
      return {
        text: result.text,
        model: result.model,
        elapsedMs: result.elapsedMs,
        profileId: String(profile.id),
        fallbackUsed: isFallback,
        // 裁剪信息一并带回：界面据此显示"系统提示词已按窗口裁剪 N 字"，不让降级悄悄发生。
        usage: { ...usage, systemPromptDroppedChars: result.systemPromptDroppedChars }
      }
    } catch (error: any) {
      lastError = error
      const code = error instanceof AgentRuntimeError ? error.code : error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED'
      if (!isFallback) recordChatUsage(agentId, String(profile.id), null, 'failed', code)
      if (!isFallback && candidates.length > 1 && canUseFallback(code, false, false)) continue
      throw error
    }
  }
  throw lastError || new AgentRuntimeError('AI_REQUEST_FAILED', '模型请求失败')
}

/** 单次补全请求（不含降级/记账）：连接失败与 429 只重试一次（§27.2）。 */
async function requestChatCompletion(profile: any, key: string, opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<{ text: string; model: string; elapsedMs: number; parsed: any; contextWindowTokens: number; maxInputTokens: number; systemPromptDroppedChars: number }> {
  assertModelEndpoint(String(profile.endpoint))
  const timeoutMs = Math.min(3600000, Math.max(1000, Math.floor(opts.timeoutMs ?? profile.timeout_ms)))
  const contextBudget = resolveAgentContextBudget({
    provider: String(profile.provider || ''),
    model: String(profile.model || ''),
    contextWindowTokens: profile.context_window_tokens == null ? null : Number(profile.context_window_tokens),
    requestedOutputTokens: Number(opts.maxTokens ?? profile.max_tokens),
    profileMaxTokens: Number(profile.max_tokens)
  })
  // 小窗口降级（审计 P1）：系统提示词以前一个字不裁，一旦它自己吃光输入预算就直接抛
  // AGENT_CONTEXT_TOO_LARGE，用户只看到"上下文过大"却无从下手。现在先按窗口裁系统提示词
  // （治理条款在最前 → 从后往前丢段落），并把裁掉多少字如实回报给界面。
  const systemBudget = Math.max(200, Math.floor(contextBudget.maxInputTokens * 0.5))
  const compactedSystem = compactSystemPrompt(opts.system, systemBudget)
  const systemTokens = estimateAgentTokens(compactedSystem.text)
  const userTokenBudget = contextBudget.maxInputTokens - systemTokens - 128
  if (userTokenBudget < 128) {
    throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', `模型上下文窗口过小：系统提示词 ${systemTokens} token 已占满输入预算 ${contextBudget.maxInputTokens} token，请为该 Profile 配置更大的上下文窗口`)
  }
  if (compactedSystem.truncated) {
    logMain('warn', `[agent] 系统提示词超出窗口已裁剪 ${compactedSystem.droppedChars} 字（输入预算 ${contextBudget.maxInputTokens} token，Profile ${String(profile.provider || '')}/${String(profile.model || '')}）`)
  }
  const boundedUser = compactAgentPrompt(opts.user, userTokenBudget)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = now()
  try {
    let response: Response | null = null
    let attempt = 0
    // §27.2：连接失败或明确的 429 只允许一次网络重试；401/403/400、取消和超时都不重试。
    for (;;) {
      try {
        response = await fetch(String(profile.endpoint), {
          method: 'POST',
          headers: buildChatRequestHeaders(key),
          body: JSON.stringify(buildChatRequestBody({
            model: profile.model,
            system: compactedSystem.text,
            user: boundedUser,
            temperature: Number(profile.temperature),
            maxTokens: clampMaxOutputTokens(contextBudget.outputTokens, 16),
            stream: false
          })),
          signal: controller.signal
        })
      } catch (error: any) {
        if (error?.name === 'AbortError' || !canRetryModelRequest('network', null, attempt)) throw error
        attempt += 1
        logMain('warn', `[agent] 模型请求连接失败（${redactAgentText(String(error?.message || error), 120)}），按 §27.2 重试一次`)
        await new Promise(resolve => setTimeout(resolve, 400))
        continue
      }
      if (response.status === 429 && canRetryModelRequest('http', 429, attempt)) {
        attempt += 1
        logMain('warn', '[agent] 模型请求遇到 HTTP 429，按 §27.2 重试一次')
        response.body?.cancel().catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 500))
        continue
      }
      break
    }
    if (!response) throw new AgentRuntimeError('AI_REQUEST_FAILED', '模型请求失败')
    const body = await response.text()
    if (!response.ok) {
      const reason = redactAgentText(`HTTP ${response.status} ${body.slice(0, 160)}`.trim(), 200)
      logMain('warn', `[agent] 模型请求失败 ${modelErrorCode(response.status)} profile=${profile.id} ${reason}`)
      throw new AgentRuntimeError(modelErrorCode(response.status), `模型接口返回 ${reason}`)
    }
    let parsed: any
    try { parsed = JSON.parse(body) } catch { throw new AgentRuntimeError('AI_INVALID_JSON', '模型响应不是合法 JSON') }
    const text = modelContent(parsed).trim()
    if (!text) throw new AgentRuntimeError('AI_EMPTY_OUTPUT', '模型返回为空')
    return { text, model: String(parsed?.model || profile.model), elapsedMs: now() - started, parsed, contextWindowTokens: contextBudget.contextWindowTokens, maxInputTokens: contextBudget.maxInputTokens, systemPromptDroppedChars: compactedSystem.droppedChars }
  } catch (error: any) {
    if (error instanceof AgentRuntimeError) throw error
    if (error?.name === 'AbortError') throw new AgentRuntimeError('AI_TIMEOUT', '模型请求超时')
    const reason = redactAgentText(String(error?.message || error), 180)
    logMain('warn', `[agent] 模型请求异常 profile=${profile.id} ${reason}`)
    throw new AgentRuntimeError('AI_REQUEST_FAILED', `模型请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function testModelProfile(profileId: string, actorAgentId: string): Promise<{ ok: true; profileId: string; model: string; elapsedMs: number; capabilities: Record<string, boolean> }> {
  requireRoot(actorAgentId)
  const profile = getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=?').get(profileId) as any
  if (!profile) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', '模型 Profile 不存在')
  assertModelEndpoint(String(profile.endpoint))
  const key = getProfileSecret(profile)
  if (!key) throw new AgentRuntimeError('AGENT_MODEL_KEY_REQUIRED', '该模型 Profile 尚未配置 API Key')
  const ac = new AbortController()
  const started = now()
  const timer = setTimeout(() => ac.abort(), Number(profile.timeout_ms))
  const failed = (code: string, message: string): never => {
    getDatabase().prepare('UPDATE agent_model_profiles SET health=?,updated_at=? WHERE id=?').run('degraded', now(), profileId)
    writeAudit('agent.model.test', 'failure', { actor: actorAgentId, requestId: `${profileId}:${code}` })
    throw new AgentRuntimeError(code, message)
  }
  try {
    // 健康检查：固定问一句 JSON，温度 0、输出 32 token（走同一个请求体构造点）
    const healthHeaders = buildChatRequestHeaders(key)
    const healthBody = JSON.stringify(buildChatRequestBody({
      model: profile.model,
      system: '只回复 JSON：{"ok":true}',
      user: 'healthcheck',
      temperature: 0,
      maxTokens: 32
    }))
    const response = await fetch(profile.endpoint, { method: 'POST', headers: healthHeaders, body: healthBody, signal: ac.signal })
    const body = await response.text()
    if (!response.ok) return failed(response.status === 429 ? 'AI_RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'AI_AUTH_FAILED' : 'AI_REQUEST_FAILED', `HTTP ${response.status}`)
    let parsed: any
    try { parsed = JSON.parse(body) } catch { return failed('AI_INVALID_JSON', '模型返回不是 JSON') }
    const text = String(parsed?.choices?.[0]?.message?.content || '')
    if (!text.trim()) return failed('AI_EMPTY_OUTPUT', '模型返回为空')
    const declaredCapabilities = parseJson<Record<string, unknown>>(profile.capabilities_json, {})
    const capabilities = { chat: !!text, json: /\{[\s\S]*\}/.test(text), vision: declaredCapabilities.vision === true, cancellation: true }
    getDatabase().prepare('UPDATE agent_model_profiles SET health=?,capabilities_json=?,updated_at=? WHERE id=?').run(capabilities.chat && capabilities.json ? 'healthy' : 'degraded', json(capabilities), now(), profileId)
    writeAudit('agent.model.test', 'success', { actor: actorAgentId, requestId: profileId })
    return { ok: true, profileId, model: String(parsed?.model || profile.model), elapsedMs: now() - started, capabilities }
  } catch (error: any) {
    if (error instanceof AgentRuntimeError) throw error
    const code = error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED'
    return failed(code, code === 'AI_TIMEOUT' ? '模型请求超时' : '模型请求失败')
  } finally { clearTimeout(timer) }
}

function modelErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AI_AUTH_FAILED'
  if (status === 408 || status === 429) return status === 429 ? 'AI_RATE_LIMITED' : 'AI_TIMEOUT'
  if (status >= 500) return 'AI_PROVIDER_OVERLOADED'
  return 'AI_REQUEST_FAILED'
}

function safeModelSummary(text: string): string {
  const bounded = redactAgentText(text, 1200).replace(MEMORY_SENSITIVE_RE, '[敏感内容已隐藏]')
  return bounded || '模型响应为空；未生成可审核正文'
}

function modelContent(parsed: any): string {
  const content = parsed?.choices?.[0]?.message?.content ?? parsed?.output_text ?? parsed?.output ?? ''
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function usageValue(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

async function executeModelJob(row: any, actorAgentId: string): Promise<any> {
  const leaseOwner = row.lease_owner || row.leaseOwner || null
  const blockIfPermissionChanged = (): boolean => {
    let assigned: AgentRecord
    try { assigned = getAgent(row.assigned_agent_id) } catch { assigned = null as any }
    if (assigned && !jobPermissionSnapshotChanged(row, assigned)) return false
    try {
      transitionJob(row.id, 'blocked_permission', actorAgentId, 'Job 权限快照已失效，拒绝使用变更后的 Agent 能力', { code: 'AGENT_PERMISSION_DENIED', reason: 'job_permission_snapshot_changed' }, ['running'], undefined, leaseOwner)
    } catch (error: any) {
      if (error?.code !== 'AGENT_JOB_LEASE_LOST' && error?.code !== 'AGENT_JOB_CONFLICT') throw error
    }
    return true
  }
  const currentOwnedJob = (): any => {
    const current = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id) as any
    if (!current || current.status !== 'running' || String(current.lease_owner || '') !== String(leaseOwner || '')) return null
    return current
  }
  if (!currentOwnedJob()) return getAgentJob(row.id)
  if (blockIfPermissionChanged()) return getAgentJob(row.id)
  const snapshot = row.model_snapshot_json ? parseJson<any>(row.model_snapshot_json, null) : null
  // v6 stores a wrapper with a frozen modelProfile/fallbackProfile.  Accept
  // the old flat public Profile shape too so jobs created before this fix can
  // still be resumed without crashing.
  const snapshotProfile = snapshot?.modelProfile || snapshot?.profile || (snapshot?.id ? snapshot : {})
  const primaryId = String(snapshot?.id || snapshotProfile?.id || '')
  const primary = primaryId ? getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(primaryId) as any : null
  if (!primary) {
    transitionJob(row.id, 'blocked_permission', actorAgentId, 'Job 没有可用模型 Profile', { code: 'AGENT_MODEL_NOT_FOUND' }, ['running'], undefined, leaseOwner)
    return getAgentJob(row.id)
  }
  const permissionSnapshot = parseJson<any>(row.permission_snapshot_json, {})
  const jobBudgets: Array<{ scope: 'agent' | 'profile'; currency?: string | null; amount: number }> = []
  if (permissionSnapshot.dailyBudget && typeof permissionSnapshot.dailyBudget.amount === 'number') {
    jobBudgets.push({ scope: 'agent', currency: permissionSnapshot.dailyBudget.currency, amount: Number(permissionSnapshot.dailyBudget.amount) })
  }
  if (snapshotProfile.dailyBudget && typeof snapshotProfile.dailyBudget.amount === 'number') {
    jobBudgets.push({ scope: 'profile', currency: snapshotProfile.dailyBudget.currency, amount: Number(snapshotProfile.dailyBudget.amount) })
  }
  if (jobBudgets.length) {
    // 单价优先用 Job 冻结的快照，快照里没有（旧 Job）再读当前 Profile
    const parsedJobPricing = modelPricingSchema.nullable().safeParse(snapshotProfile.pricing ?? parseJson(primary.pricing_json, null))
    const jobPricing = (parsedJobPricing.success ? parsedJobPricing.data : null) as PricingLike | null
    try {
      assertDailyBudget({
        agentId: String(row.assigned_agent_id),
        budgets: jobBudgets,
        pricing: jobPricing,
        reserve: { outputTokens: Math.max(0, Number(snapshotProfile.maxTokens ?? primary.max_tokens ?? 0)) }
      })
    } catch (error: any) {
      // 预算不生效时必须让 Job 停在 blocked_budget，并把真实原因写进 Job 事件（不再假装通过）
      transitionJob(row.id, 'blocked_budget', actorAgentId, String(error?.message || 'Agent 或模型 Profile 达到日预算边界'), { code: String(error?.code || 'AGENT_BUDGET_BLOCKED'), budgetScopes: jobBudgets.map(item => `${item.scope}:${item.amount}${item.currency || 'tokens'}`) }, ['running'], undefined, leaseOwner)
      return getAgentJob(row.id)
    }
  }
  const configuredCandidates: Array<{ row: any; config: any; fallbackUsed: boolean }> = [{ row: primary, config: snapshotProfile, fallbackUsed: false }]
  if (snapshot?.fallbackProfile?.enabled !== false && snapshot?.fallbackProfile && canUseFallback('AI_REQUEST_FAILED', false, row.risk === 'submit')) {
    const fallbackId = String(snapshot.fallbackProfile.id || '')
    const fallbackRow = fallbackId ? getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(fallbackId) as any : null
    if (fallbackRow) configuredCandidates.push({ row: fallbackRow, config: snapshot.fallbackProfile, fallbackUsed: true })
  }
  // 能力探测参与路由（审计 P2-A）：探测明确不可用的 Profile 直接不参与候选。
  // 全部不可用时要停在 blocked_permission 而不是拿一个不能输出 JSON 的模型硬跑。
  const incapableProfiles: string[] = []
  const candidates = configuredCandidates.filter(candidate => {
    const verdict = modelCapabilityVerdict(parseJson(candidate.row?.capabilities_json, {}))
    if (verdict.warning) logMain('warn', `[agent] Job ${row.id} 模型 Profile 能力探测提示 profile=${candidate.row?.id} warning=${verdict.warning}`)
    if (verdict.usable) return true
    incapableProfiles.push(String(candidate.row?.name || candidate.row?.id || '未知 Profile'))
    logMain('warn', `[agent] Job ${row.id} 跳过能力探测未通过的模型 Profile profile=${candidate.row?.id} reason=${verdict.code}`)
    return false
  })
  if (!candidates.length) {
    transitionJob(row.id, 'blocked_permission', actorAgentId, `模型 Profile 未通过能力探测：${incapableProfiles.join('、')}（请到「设置 → 模型」重新测试或换 Profile）`, { code: 'AGENT_MODEL_INCAPABLE', profiles: incapableProfiles }, ['running'], undefined, leaseOwner)
    return getAgentJob(row.id)
  }
  const { buildApprovedMemoryContext } = await import('./agent-memory')
  // 岗位层提示词要用到执行者的名称/岗位/职责/成功标准（审计 P1）：取一次，
  // 取不到（Agent 被删除等）就退化成通用执行者提示，不让 Job 因为提示词而失败。
  const jobAgent = (() => { try { return getAgent(String(row.assigned_agent_id)) } catch { return null } })()
  const candidateContextBudgets = candidates.map(candidate => {
    const candidateProfile = candidate.row
    const candidateConfig = candidate.config || candidateProfile
    return resolveAgentContextBudget({
      provider: String(candidateConfig.provider ?? candidateProfile.provider ?? ''),
      model: String(candidateConfig.model ?? candidateProfile.model ?? ''),
      contextWindowTokens: candidateConfig.contextWindowTokens == null
        ? (candidateProfile.context_window_tokens == null ? null : Number(candidateProfile.context_window_tokens))
        : Number(candidateConfig.contextWindowTokens),
      requestedOutputTokens: Number(candidateConfig.maxTokens ?? candidateProfile.max_tokens),
      profileMaxTokens: Number(candidateConfig.maxTokens ?? candidateProfile.max_tokens)
    })
  })
  const primaryContextBudget = candidateContextBudgets[0]
  const smallestContextBudget = candidateContextBudgets.reduce((smallest, budget) => budget.memoryChars < smallest.memoryChars ? budget : smallest, primaryContextBudget)
  const configuredMemoryChars = getSettingNumber('agent.memory.maxContextChars', 0, 0, 200000)
  const memoryChars = configuredMemoryChars > 0 ? Math.min(configuredMemoryChars, smallestContextBudget.memoryChars) : smallestContextBudget.memoryChars
  const memoryContext = buildApprovedMemoryContext(
    row.assigned_agent_id,
    row.store_id || null,
    row.goal,
    Math.min(50, Math.max(8, Math.floor(memoryChars / 420))),
    memoryChars,
    row.id
  )
  let finalCode = 'AI_REQUEST_FAILED'
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]
    if (!currentOwnedJob()) return getAgentJob(row.id)
    const profile = candidate.row
    const config = candidate.config || profile
    const key = getProfileSecret(profile)
    if (!key) { finalCode = 'AGENT_MODEL_KEY_REQUIRED'; break }
    const controller = new AbortController()
    modelJobControllers.set(row.id, controller)
    const started = now()
    const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs ?? profile.timeout_ms))
    try {
      let response: Response | null = null
      let attempt = 0
      const contextBudget = candidateContextBudgets[candidateIndex]
      // 岗位层提示词（审计 P1）：以前这里是写死的一句话，招聘出的"数据分析/审核 Agent"和
      // 随便一个执行者拿到的是同一段提示，组织配置对模型行为没有影响。现在把岗位、职责、
      // 成功标准编进去，并按上下文窗口做同一套降级。
      const baseSystemPrompt = buildAgentJobSystemPrompt(jobAgent ? {
        name: jobAgent.name,
        role: jobAgent.role,
        description: jobAgent.description,
        successCriteria: jobAgent.successCriteria
      } : null)
      const compactedJobSystem = compactSystemPrompt(baseSystemPrompt, Math.max(200, Math.floor(contextBudget.maxInputTokens * 0.5)))
      const modelSystemPrompt = compactedJobSystem.text
      const modelUserPayload = JSON.stringify({ goal: row.goal, inputSummary: parseJson(row.input_summary_json, {}), approvedMemory: memoryContext })
      const userTokenBudget = contextBudget.maxInputTokens - estimateAgentTokens(modelSystemPrompt) - 128
      if (userTokenBudget < 128) {
        finalCode = 'AGENT_CONTEXT_TOO_LARGE'
        logMain('warn', `[agent] Job 上下文窗口过小：系统提示词 ${estimateAgentTokens(modelSystemPrompt)} token / 输入预算 ${contextBudget.maxInputTokens} token（Job ${row.id}）`)
        continue
      }
      const boundedUserPayload = compactAgentPrompt(modelUserPayload, userTokenBudget)
      // §27.2：连接失败或明确的 429 只允许一次网络重试；取消、401/403 等不重试。
      for (;;) {
        try {
          response = await fetch(String(config.endpoint ?? profile.endpoint), {
            method: 'POST',
            headers: buildChatRequestHeaders(key),
            body: JSON.stringify(buildChatRequestBody({
              model: String(config.model ?? profile.model),
              system: modelSystemPrompt,
              user: boundedUserPayload,
              temperature: Number(config.temperature ?? profile.temperature),
              maxTokens: contextBudget.outputTokens,
              stream: false
            })),
            signal: controller.signal
          })
        } catch (error: any) {
          if (error?.name === 'AbortError' || !canRetryModelRequest('network', null, attempt)) throw error
          attempt += 1
          logMain('warn', `[agent] Job 模型请求连接失败（${redactAgentText(String(error?.message || error), 120)}），按 §27.2 重试一次`)
          await new Promise(resolve => setTimeout(resolve, 400))
          continue
        }
        if (response.status === 429 && canRetryModelRequest('http', 429, attempt)) {
          attempt += 1
          logMain('warn', '[agent] Job 模型请求遇到 HTTP 429，按 §27.2 重试一次')
          response.body?.cancel().catch(() => undefined)
          await new Promise(resolve => setTimeout(resolve, 500))
          continue
        }
        break
      }
      const body = await response!.text()
      if (!currentOwnedJob()) return getAgentJob(row.id)
      if (blockIfPermissionChanged()) return getAgentJob(row.id)
      if (!response.ok) { finalCode = modelErrorCode(response.status); logMain('warn', `[agent] Job 模型请求失败 ${finalCode} profile=${profile.id} HTTP ${response.status} ${redactAgentText(body.slice(0, 160), 200)}`); if (canUseFallback(finalCode, !!row.side_effect_started, row.risk === 'submit')) continue; break }
      let parsed: any
      try { parsed = JSON.parse(body) } catch { finalCode = 'AI_INVALID_JSON'; break }
      const content = modelContent(parsed)
      if (!content.trim()) { finalCode = 'AI_EMPTY_OUTPUT'; break }
      const inputTokens = usageValue(parsed?.usage?.prompt_tokens)
      const outputTokens = usageValue(parsed?.usage?.completion_tokens)
      const elapsedMs = now() - started
      const outputHash = createHash('sha256').update(content, 'utf8').digest('hex')
      // Cost stays honest: only a configured per-million-token price produces a
      // bounded estimate. Without one the usage row keeps cost_json NULL and the
      // quality review continues to report "未估算".
      const pricing = config.pricing && typeof config.pricing === 'object' ? config.pricing : null
      const inputRate = pricing ? Number(pricing.inputPerMTok || 0) : 0
      const outputRate = pricing ? Number(pricing.outputPerMTok || 0) : 0
      const estimatedCost = pricing && (inputRate > 0 || outputRate > 0)
        ? Number((((inputTokens * inputRate) + (outputTokens * outputRate)) / 1000000).toFixed(12))
        : null
      const costCurrency = estimatedCost == null ? null : String(pricing?.currency || 'USD')
      const costJson = estimatedCost == null ? null : json({ amount: estimatedCost, currency: costCurrency, source: 'configured_estimate' })
      transitionJob(row.id, 'succeeded', actorAgentId, candidate.fallbackUsed ? '主模型失败后按白名单切换备用 Profile，模型结果已落库' : '模型请求完成，结果摘要和 hash 已落库', { profileId: profile.id, model: String(config.model ?? profile.model), outputHash, elapsedMs, estimatedCost, costCurrency }, ['running'], undefined, leaseOwner, (db, t) => {
        // Persist usage and evidence in the same transaction as the guarded
        // lease/status update.  A cancelled or superseded Worker therefore
        // cannot leave a result behind after its transition is rejected.
        db.prepare('INSERT INTO agent_usage(id,agent_id,profile_id,job_id,input_tokens,output_tokens,cost_json,estimated,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`ause_${randomUUID()}`, row.assigned_agent_id, profile.id, row.id, inputTokens, outputTokens, costJson, estimatedCost != null || (inputTokens === 0 && outputTokens === 0) ? 1 : 0, 'succeeded', null, t)
        emitUsageUpdated(String(row.assigned_agent_id), String(profile.id), 'succeeded')
        db.prepare('INSERT INTO agent_job_results(id,job_id,task_run_id,kind,summary,evidence_json,approved,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`ajres_${randomUUID()}`, row.id, null, 'model', safeModelSummary(content), json({ profileId: profile.id, model: String(config.model ?? profile.model), elapsedMs, outputHash, inputTokens, outputTokens, estimatedCost, costCurrency, fallbackUsed: candidate.fallbackUsed }), 0, t)
      })
      try {
        const { learnFromJobResults } = await import('./agent-memory')
        learnFromJobResults({ jobId: String(row.id), storeId: row.store_id || null, goal: String(row.goal || ''), status: 'succeeded', results: [{ kind: 'model', summary: safeModelSummary(content), evidence: { outputHash } }] })
      } catch { /* learning must not change the truthful Job result */ }
      return getAgentJob(row.id)
    } catch (error: any) {
      if (error?.code === 'AGENT_JOB_LEASE_LOST' || error?.code === 'AGENT_JOB_CONFLICT' || !currentOwnedJob()) return getAgentJob(row.id)
      finalCode = error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED'
      if (canUseFallback(finalCode, !!row.side_effect_started, row.risk === 'submit')) continue
    } finally {
      clearTimeout(timer)
      modelJobControllers.delete(row.id)
    }
  }
  const terminal = finalCode === 'AGENT_MODEL_KEY_REQUIRED' ? 'blocked_permission' : 'failed'
  try {
    transitionJob(row.id, terminal, actorAgentId, finalCode === 'AGENT_MODEL_KEY_REQUIRED' ? '模型 Profile 没有可用 Key，Job 阻塞在权限边界' : `模型请求失败：${finalCode}`, { code: finalCode }, ['running'], undefined, leaseOwner, (db, t) => {
      try {
        db.prepare('INSERT INTO agent_usage(id,agent_id,profile_id,job_id,input_tokens,output_tokens,cost_json,estimated,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`ause_${randomUUID()}`, row.assigned_agent_id, primary.id, row.id, 0, 0, null, 1, terminal, finalCode, t)
        emitUsageUpdated(String(row.assigned_agent_id), String(primary.id), terminal)
      } catch { /* usage logging must not hide the truthful Job state */ }
    })
  } catch (error: any) {
    if (error?.code === 'AGENT_JOB_LEASE_LOST' || error?.code === 'AGENT_JOB_CONFLICT') return getAgentJob(row.id)
    throw error
  }
  return getAgentJob(row.id)
}

/**
 * Resolve one configured fallback in Main.  The caller still owns the model
 * request and must pass the frozen Job snapshot; this helper never retries a
 * request after a page side effect or for a high-risk Job.
 */
export function resolveFallbackProfile(profileId: string, errorCode: string, sideEffectStarted = false, highRisk = false): ModelProfile | null {
  if (!canUseFallback(errorCode, sideEffectStarted, highRisk)) return null
  const seen = new Set<string>()
  const current = getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(profileId) as any
  while (current?.fallback_profile_id && !seen.has(String(current.id))) {
    seen.add(String(current.id))
    const fallback = getDatabase().prepare('SELECT * FROM agent_model_profiles WHERE id=? AND enabled=1').get(String(current.fallback_profile_id)) as any
    if (!fallback) return null
    return mapProfile(fallback)
  }
  return null
}

function jobRow(row: any): any {
  const events = (getDatabase().prepare('SELECT id,from_status as fromStatus,to_status as toStatus,actor,reason,evidence_json as evidence,created_at as createdAt FROM agent_job_events WHERE job_id=? ORDER BY created_at ASC LIMIT 200').all(row.id) as any[]).map(event => ({ ...event, evidence: event.evidence ? parseJson(event.evidence, null) : null }))
  const results = (getDatabase().prepare('SELECT id,task_run_id as taskRunId,kind,summary,evidence_json as evidence,approved,reviewer_agent_id as reviewerAgentId,created_at as createdAt FROM agent_job_results WHERE job_id=? ORDER BY created_at ASC LIMIT 100').all(row.id) as any[]).map(result => ({ ...result, approved: !!result.approved, evidence: parseJson(result.evidence, {}) }))
  return {
    id: row.id, parentJobId: row.parent_job_id || null, createdByAgentId: row.created_by_agent_id,
    assignedAgentId: row.assigned_agent_id, browserTaskId: row.browser_task_id || null, browserRunId: row.browser_run_id || null,
    storeId: row.store_id || null, goal: row.goal, inputSummary: parseJson(row.input_summary_json, {}),
    status: row.status, priority: Number(row.priority), requiresConfirmation: !!row.requires_confirmation,
    confirmationId: row.confirmation_id || null, confirmationApproved: !!row.confirmation_approved,
    confirmationExpiresAt: row.confirmation_expires_at || null,
    leaseOwner: row.lease_owner || null, leaseExpiresAt: row.lease_expires_at || null,
    idempotencyKey: row.idempotency_key, attemptCount: Number(row.attempt_count), version: Number(row.version),
    risk: row.risk, sideEffectStarted: !!row.side_effect_started, modelSnapshot: row.model_snapshot_json ? parseJson(row.model_snapshot_json, null) : null,
    permissionSnapshot: parseJson(row.permission_snapshot_json, {}), storeScopeSnapshot: parseJson(row.store_scope_snapshot_json, {}), memoryScopeSnapshot: parseJson(row.memory_scope_snapshot_json, {}),
    dependencies: parseJson(row.dependencies_json, []), createdAt: Number(row.created_at), startedAt: row.started_at || null, completedAt: row.completed_at || null, updatedAt: Number(row.updated_at), events, results
  }
}

type JobTransitionPatch = {
  confirmationApproved?: boolean
  confirmationExpiresAt?: number | null
  sideEffectStarted?: boolean
}

type JobTransitionAfterUpdate = (db: any, timestamp: number, current: any) => void

function transitionJob(jobId: string, to: string, actor: string, reason: string, evidence: unknown = null, expected?: string[], patch?: JobTransitionPatch, leaseOwner?: string, afterUpdate?: JobTransitionAfterUpdate): any {
  const db = getDatabase()
  const current = db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId) as any
  if (!current) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (leaseOwner && String(current.lease_owner || '') !== leaseOwner) throw new AgentRuntimeError('AGENT_JOB_LEASE_LOST', 'Agent Job 租约已失效，拒绝写回旧 Worker 结果')
  if (expected && !expected.includes(current.status)) throw new AgentRuntimeError('AGENT_JOB_BAD_STATE', `不允许 ${current.status} -> ${to}`)
  if (!canTransition(current.status, to)) throw new AgentRuntimeError('AGENT_JOB_BAD_STATE', `不允许 ${current.status} -> ${to}`)
  const t = now()
  const terminal = ['succeeded', 'failed', 'cancelled', 'expired', 'blocked_budget', 'blocked_permission'].includes(to)
  const clearLease = terminal || to === 'recovery_required'
  const completedAt = terminal ? t : null
  const result = db.transaction(() => {
    const sets = [
      'status=?', 'version=version+1', 'updated_at=?',
      'completed_at=CASE WHEN ? IS NULL THEN completed_at ELSE ? END',
      'lease_owner=CASE WHEN ?=1 THEN NULL ELSE lease_owner END',
      'lease_expires_at=CASE WHEN ?=1 THEN NULL ELSE lease_expires_at END',
      "started_at=CASE WHEN ?='running' AND started_at IS NULL THEN ? ELSE started_at END"
    ]
    const values: unknown[] = [to, t, completedAt, completedAt, clearLease ? 1 : 0, clearLease ? 1 : 0, to, t]
    if (patch?.confirmationApproved !== undefined) { sets.push('confirmation_approved=?'); values.push(patch.confirmationApproved ? 1 : 0) }
    if (patch?.confirmationExpiresAt !== undefined) { sets.push('confirmation_expires_at=?'); values.push(patch.confirmationExpiresAt) }
    if (patch?.sideEffectStarted !== undefined) { sets.push('side_effect_started=?'); values.push(patch.sideEffectStarted ? 1 : 0) }
    values.push(jobId, current.version)
    const changed = db.prepare(`UPDATE agent_jobs SET ${sets.join(',')} WHERE id=? AND version=?`).run(...values)
    if (changed.changes !== 1) throw new AgentRuntimeError('AGENT_JOB_CONFLICT', 'Job 已被其他执行者更新，请刷新后重试')
    afterUpdate?.(db, t, current)
    db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`ajev_${randomUUID()}`, jobId, current.status, to, actor, redactAgentText(reason, 500), evidence == null ? null : json(evidence), t)
  })()
  void result
  writeAudit('agent.job.transition', 'success', { actor, requestId: `${jobId}:${current.status}->${to}` })
  return jobRow(db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId))
}

function validateJobDependencies(dependencies: string[]): string[] {
  const unique = [...new Set(dependencies)]
  if (unique.length !== dependencies.length) throw new AgentRuntimeError('AGENT_INVALID_INPUT', 'Job dependencies 不能重复')
  const maxDepth = getSettingNumber('agent.jobs.maxDepth', 12, 1, 12)
  const maxNodes = getSettingNumber('agent.jobs.maxNodes', 50, 1, 200)
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (depth > maxDepth) throw new AgentRuntimeError('AGENT_DAG_LIMIT', 'Job dependency DAG 超过最大深度')
    if (visiting.has(id)) throw new AgentRuntimeError('AGENT_DAG_LIMIT', 'Job dependency DAG 存在循环')
    if (visited.has(id)) return
    const row = getDatabase().prepare('SELECT dependencies_json FROM agent_jobs WHERE id=?').get(id) as any
    if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Job dependency 不存在')
    visiting.add(id)
    visited.add(id)
    for (const dependency of parseJson<string[]>(row.dependencies_json, [])) walk(String(dependency), depth + 1)
    visiting.delete(id)
    if (visited.size + 1 > maxNodes) throw new AgentRuntimeError('AGENT_DAG_LIMIT', 'Job dependency DAG 超过最大节点数')
  }
  for (const id of unique) walk(id, 1)
  return unique
}

function dependencyState(row: any): { waiting: string[]; failed: string[]; missing: string[] } {
  const waiting: string[] = []; const failed: string[] = []; const missing: string[] = []
  for (const id of parseJson<string[]>(row.dependencies_json, [])) {
    const dependency = getDatabase().prepare('SELECT id,status FROM agent_jobs WHERE id=?').get(id) as any
    if (!dependency) { missing.push(String(id)); continue }
    if (dependency.status === 'succeeded') continue
    if (['failed', 'cancelled', 'expired', 'blocked_budget', 'blocked_permission', 'recovery_required'].includes(dependency.status)) failed.push(String(id))
    else waiting.push(String(id))
  }
  return { waiting, failed, missing }
}

export function createAgentJob(raw: AgentJobCreate, opts: { moneyConfirmationSatisfied?: boolean } = {}): any {
  const input = agentJobCreateSchema.parse(raw)
  const actor = requireAgent(input.createdByAgentId)
  const assigned = requireAgent(input.assignedAgentId)
  const risk = deriveRisk(input)
  assertAgentCanCreateJob(actor, assigned, input, risk, opts.moneyConfirmationSatisfied === true)
  const dependencyIds = validateJobDependencies(input.dependencies)
  if (input.parentJobId) {
    const parent = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.parentJobId) as any
    if (!parent) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', '父 Job 不存在')
    const childCount = (getDatabase().prepare('SELECT COUNT(*) c FROM agent_jobs WHERE parent_job_id=?').get(input.parentJobId) as any).c
    if (childCount >= 12) throw new AgentRuntimeError('AGENT_DAG_LIMIT', '单个 Job 最多 12 个直接子 Job')
    const nodeCount = Number((getDatabase().prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM agent_jobs WHERE id=?
      UNION ALL
      SELECT j.id FROM agent_jobs j JOIN descendants d ON j.parent_job_id=d.id
    ) SELECT COUNT(*) c FROM descendants`).get(input.parentJobId) as any)?.c || 0)
    if (nodeCount + 1 > getSettingNumber('agent.jobs.maxNodes', 50, 1, 200)) throw new AgentRuntimeError('AGENT_DAG_LIMIT', 'Job DAG 超过最大节点数')
    let depth = 1; let cursor = parent
    while (cursor?.parent_job_id) { depth++; cursor = getDatabase().prepare('SELECT parent_job_id FROM agent_jobs WHERE id=?').get(cursor.parent_job_id) as any }
    if (depth >= getSettingNumber('agent.jobs.maxDepth', 12, 1, 12)) throw new AgentRuntimeError('AGENT_DAG_LIMIT', 'Job DAG 超过最大深度')
  }
  const safeGoal = redactAgentText(input.goal, 2000)
  const safeInputSummary = sanitizeJobValue(input.inputSummary) as Record<string, unknown>
  const hash = payloadHash(input)
  const existing = getDatabase().prepare('SELECT * FROM agent_jobs WHERE idempotency_key=?').get(input.idempotencyKey) as any
  if (existing) {
    if (existing.payload_hash !== hash) throw new AgentRuntimeError('AGENT_JOB_DUPLICATE', '相同幂等键的 payload 不一致')
    return getAgentJob(existing.id)
  }
  const resolvedModel = resolveEffectiveAgentModel(assigned.id)
  const profile = resolvedModel.profile
  if (resolvedModel.profileId && !profile) throw new AgentRuntimeError('AGENT_MODEL_NOT_FOUND', 'Agent 生效的模型 Profile 不存在或已停用')
  const frozenSnapshot = snapshotForJob(actor, assigned, profile, profile ? (resolvedModel.inherited ? 'inherited' : 'bound') : 'none')
  const modelSnapshot = profile ? {
    id: profile.id,
    modelProfile: frozenSnapshot.modelProfile,
    fallbackProfile: frozenSnapshot.fallbackProfile,
    capturedAt: frozenSnapshot.capturedAt
  } : null
  const id = `ajob_${randomUUID()}`
  const t = now()
  let browserTaskId: string | null = null
  if (input.browserTask) {
    if (!input.storeId) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '浏览器 Job 必须指定 storeId')
    const safeBrowserTask = sanitizeJobValue(input.browserTask) as NonNullable<AgentJobCreate['browserTask']>
    const task = TaskStore.createTask({ name: safeBrowserTask.name, storeScope: safeBrowserTask.storeScope || input.storeId, steps: safeBrowserTask.steps as any } as any)
    browserTaskId = task.id
  }
  const db = getDatabase()
  db.transaction(() => {
    db.prepare(`INSERT INTO agent_jobs(id,parent_job_id,created_by_agent_id,assigned_agent_id,browser_task_id,browser_run_id,store_id,goal,input_summary_json,permission_snapshot_json,store_scope_snapshot_json,memory_scope_snapshot_json,model_snapshot_json,payload_hash,status,priority,requires_confirmation,confirmation_id,confirmation_approved,confirmation_expires_at,lease_owner,lease_expires_at,idempotency_key,attempt_count,version,dependencies_json,risk,side_effect_started,created_at,started_at,completed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.parentJobId, input.createdByAgentId, input.assignedAgentId, browserTaskId, null, input.storeId, safeGoal, json(safeInputSummary), json(frozenSnapshot), json(assigned.storeScope), json(assigned.memoryScope), modelSnapshot ? json(modelSnapshot) : null, hash, 'queued', input.priority, input.requiresConfirmation ? 1 : 0, input.requiresConfirmation ? `confirm_${randomUUID()}` : null, 0, null, null, null, input.idempotencyKey, 0, 0, json(dependencyIds), risk, 0, t, null, null, t
    )
    db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`ajev_${randomUUID()}`, id, null, 'queued', input.createdByAgentId, 'Job 已创建并冻结权限、店铺、记忆和模型快照', null, t)
  })()
  writeAudit('agent.job.create', 'success', { actor: input.createdByAgentId, storeId: input.storeId, requestId: id })
  return jobRow(db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id))
}

function syncBrowserJob(row: any): any {
  if (!row.browser_run_id || !['running', 'accepted', 'waiting_confirmation'].includes(row.status)) return jobRow(row)
  const currentJob = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id) as any
  if (!currentJob) return jobRow(row)
  if (currentJob.status !== row.status || String(currentJob.lease_owner || '') !== String(row.lease_owner || '') || String(currentJob.browser_run_id || '') !== String(row.browser_run_id || '')) return jobRow(currentJob)
  const run = TaskStore.getRun(row.browser_run_id)
  if (!run) return row
  if (run.status === 'running' && row.risk !== 'read' && !row.side_effect_started) {
    markJobSideEffectStarted(row.id, ROOT_AGENT_ID, { taskRunId: run.id, risk: row.risk }, row.lease_owner || undefined)
  }
  if (run.status === 'succeeded' && row.status !== 'succeeded') {
    const result = TaskStore.getResults(run.id)
    const db = getDatabase()
    try {
      db.transaction(() => {
        transitionJob(row.id, 'succeeded', ROOT_AGENT_ID, 'TaskRunner 完成，证据已落库', { taskRunId: run.id, stepEvidenceCount: result?.results.length || 0 }, ['running', 'accepted'], undefined, row.lease_owner || undefined)
        if (result) for (const item of result.results) db.prepare('INSERT INTO agent_job_results(id,job_id,task_run_id,kind,summary,evidence_json,approved,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`ajres_${randomUUID()}`, row.id, run.id, item.kind, redactAgentText(item.summary, 240), json({ artifactSha256: item.artifactSha256, artifactPath: item.artifactPath, stepIndex: item.stepIndex }), 0, now())
      })()
    } catch (error: any) {
      if (error?.code !== 'AGENT_JOB_LEASE_LOST' && error?.code !== 'AGENT_JOB_CONFLICT') throw error
      const latest = db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id) as any
      return latest ? jobRow(latest) : row
    }
    // Evidence is authoritative in TaskRunner/agent_job_results.  The memory
    // learner receives only the persisted summary and creates a pending
    // episodic candidate; it never promotes raw page text directly.
    void import('./agent-memory').then(({ learnFromJobResults }) => learnFromJobResults({
      jobId: String(row.id), storeId: row.store_id || null, goal: String(row.goal || ''), status: 'succeeded',
      results: (result?.results || []).map((item: any) => ({ summary: item.summary, kind: item.kind, evidence: { stepIndex: item.stepIndex, artifactSha256: item.artifactSha256 } }))
    })).catch(() => undefined)
  } else if (['failed', 'cancelled'].includes(run.status) && !['failed', 'cancelled'].includes(row.status)) {
    try {
      transitionJob(row.id, run.status === 'cancelled' ? 'cancelled' : 'failed', ROOT_AGENT_ID, run.errorCode || 'TaskRunner 失败', { taskRunId: run.id, errorCode: run.errorCode }, ['running', 'accepted'], undefined, row.lease_owner || undefined)
    } catch (error: any) {
      if (error?.code !== 'AGENT_JOB_LEASE_LOST' && error?.code !== 'AGENT_JOB_CONFLICT') throw error
      const latest = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id) as any
      return latest ? jobRow(latest) : row
    }
  }
  return jobRow(getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id))
}

function markJobSideEffectStarted(jobId: string, actor: string, evidence: unknown, leaseOwner?: string): void {
  const db = getDatabase()
  const t = now()
  const changed = leaseOwner
    ? db.prepare('UPDATE agent_jobs SET side_effect_started=1,updated_at=? WHERE id=? AND status IN (\'running\',\'accepted\') AND side_effect_started=0 AND lease_owner=?').run(t, jobId, leaseOwner)
    : db.prepare('UPDATE agent_jobs SET side_effect_started=1,updated_at=? WHERE id=? AND status IN (\'running\',\'accepted\') AND side_effect_started=0').run(t, jobId)
  if (changed.changes !== 1) return
  db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) SELECT ?,id,status,status,?,?,?,? FROM agent_jobs WHERE id=?').run(`ajev_${randomUUID()}`, actor, '进入页面副作用边界；后续禁止盲目重试', evidence == null ? null : json(evidence), t, jobId)
  writeAudit('agent.job.side_effect_started', 'success', { actor, requestId: jobId })
}

export function getAgentJob(jobId: string): any {
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  return syncBrowserJob(row)
}

export function listAgentJobs(raw: unknown = {}): { items: any[]; nextCursor: string | null; hasMore: boolean } {
  const query = agentJobListQuerySchema.parse(raw)
  const params: any[] = []
  const where: string[] = []
  if (query.status) { where.push('status=?'); params.push(query.status) }
  if (query.assignedAgentId) { where.push('assigned_agent_id=?'); params.push(query.assignedAgentId) }
  if (query.storeId) { where.push('store_id=?'); params.push(query.storeId) }
  if (query.cursor) { const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|'); if (decoded.length === 2) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); params.push(Number(decoded[0]), Number(decoded[0]), decoded[1]) } }
  params.push(query.limit + 1)
  const rows = getDatabase().prepare(`SELECT * FROM agent_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params) as any[]
  const hasMore = rows.length > query.limit
  const items = rows.slice(0, query.limit).map(row => getAgentJob(row.id))
  const last = items.at(-1)
  const nextCursor = hasMore && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null
  return { items, nextCursor, hasMore }
}

export async function runAgentJob(jobId: string, actorAgentId: string): Promise<any> {
  const actor = requireRoot(actorAgentId)
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (['queued', 'accepted'].includes(row.status)) {
    const dependencies = dependencyState(row)
    if (dependencies.missing.length || dependencies.failed.length) {
      return transitionJob(row.id, 'blocked_permission', actor.id, 'Job 依赖不存在或未成功完成', { code: 'AGENT_JOB_DEPENDENCY_FAILED', missing: dependencies.missing, failed: dependencies.failed }, [row.status])
    }
    if (dependencies.waiting.length) throw new AgentRuntimeError('AGENT_JOB_DEPENDENCY_WAITING', `Job 依赖尚未完成：${dependencies.waiting.join(', ')}`)
  }
  const assigned = requireAgent(row.assigned_agent_id)
  if (assigned.id === ROOT_AGENT_ID) {
    // root-ceo is chat / dispatch / review only. Pre-existing root jobs (if a
    // database predates the guard) must be blocked instead of executed.
    if (['queued', 'accepted', 'waiting_confirmation'].includes(row.status)) {
      transitionJob(row.id, 'blocked_permission', actor.id, '主 Agent 不执行任务；需要执行的任务必须派给子 Agent', { code: 'AGENT_ROOT_CANNOT_EXECUTE' }, [row.status])
      return getAgentJob(row.id)
    }
    throw new AgentRuntimeError('AGENT_ROOT_CANNOT_EXECUTE', '主 Agent 只负责对话、拆分和派单，不执行任务')
  }
  if (jobPermissionSnapshotChanged(row, assigned)) {
    if (['queued', 'accepted', 'waiting_confirmation'].includes(row.status)) {
      transitionJob(row.id, 'blocked_permission', actor.id, 'Job 权限快照已失效，拒绝使用变更后的 Agent 能力', { code: 'AGENT_PERMISSION_DENIED', reason: 'job_permission_snapshot_changed' }, [row.status])
      return getAgentJob(row.id)
    }
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', 'Job 权限快照已失效，请重新创建 Job')
  }
  if (['paused', 'retired'].includes(assigned.status)) {
    if (['queued', 'accepted'].includes(row.status)) {
      transitionJob(row.id, 'blocked_permission', actor.id, 'assigned Agent 当前已暂停或退休', { agentStatus: assigned.status }, [row.status])
      return getAgentJob(row.id)
    }
    throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', 'assigned Agent 当前已暂停或退休')
  }
  try { assertStoreScope(assigned, row.store_id || null) } catch (error) {
    if (['queued', 'accepted'].includes(row.status)) {
      transitionJob(row.id, 'blocked_permission', actor.id, 'Job 执行前重新校验店铺范围失败', { code: (error as any)?.code || 'AGENT_PERMISSION_DENIED' }, [row.status])
      return getAgentJob(row.id)
    }
    throw error
  }
  const activeAgentJobs = Number((getDatabase().prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE assigned_agent_id=? AND status='running'").get(assigned.id) as any)?.c || 0)
  if (activeAgentJobs >= assigned.maxConcurrency) throw new AgentRuntimeError('AGENT_CONCURRENCY_LIMIT', 'Agent 已达到 maxConcurrency，请等待现有 Job 结束')
  const frozenModelSnapshot = row.model_snapshot_json ? parseJson<any>(row.model_snapshot_json, null) : null
  const frozenProfileId = String(frozenModelSnapshot?.id || frozenModelSnapshot?.modelProfile?.id || assigned.modelProfileId || '')
  if (!row.browser_task_id && frozenProfileId) {
    const profile = getDatabase().prepare('SELECT concurrency_limit FROM agent_model_profiles WHERE id=? AND enabled=1').get(frozenProfileId) as any
    const activeProfileJobs = Number((getDatabase().prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE status='running' AND json_extract(model_snapshot_json, '$.id')=?").get(frozenProfileId) as any)?.c || 0)
    if (profile && activeProfileJobs >= Number(profile.concurrency_limit)) throw new AgentRuntimeError('AGENT_CONCURRENCY_LIMIT', '模型 Profile 已达到 concurrencyLimit，请等待现有 Job 结束')
  }
  if (row.status === 'waiting_confirmation') {
    if (row.confirmation_expires_at && Number(row.confirmation_expires_at) <= now()) {
      return transitionJob(jobId, 'expired', actor.id, '人工确认已过期', { confirmationExpired: true }, ['waiting_confirmation'])
    }
    throw new AgentRuntimeError('AGENT_JOB_BAD_STATE', 'Job 正在等待人工确认')
  }
  if (row.requires_confirmation && !row.confirmation_approved && ['queued', 'accepted'].includes(row.status)) {
    if (row.confirmation_expires_at && Number(row.confirmation_expires_at) <= now()) {
      return transitionJob(jobId, 'expired', actor.id, '人工确认已过期', { confirmationExpired: true }, [row.status])
    }
    if (row.status === 'queued') transitionJob(jobId, 'accepted', actor.id, 'Dispatcher 接受 Job', null, ['queued'])
    return transitionJob(jobId, 'waiting_confirmation', actor.id, '高风险动作等待人工确认', null, ['accepted'], {
      confirmationExpiresAt: now() + getSettingNumber('agent.jobs.confirmationTtlMs', 600000, 1000, 86400000)
    })
  }
  if (!['queued', 'accepted'].includes(row.status)) throw new AgentRuntimeError('AGENT_JOB_BAD_STATE', `当前状态 ${row.status} 不能运行`)
  const lease = `worker_${randomUUID()}`
  const t = now()
  const db = getDatabase()
  const changed = db.prepare('UPDATE agent_jobs SET status=?,lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,version=version+1,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND version=? AND status IN (\'queued\',\'accepted\')').run('running', lease, t + getSettingNumber('agent.jobs.leaseMs', 30000, 5000, 300000), t, t, jobId, row.version)
  if (changed.changes !== 1) throw new AgentRuntimeError('AGENT_JOB_CONFLICT', 'Job 已被其他执行者接受')
  db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`ajev_${randomUUID()}`, jobId, row.status, 'running', actor.id, 'Dispatcher 获得租约', null, t)
  if (row.browser_task_id) {
    // TaskRunner 的排队泵只启动“店铺已打开”的运行；浏览器 Job 在这里保证目标店铺已打开，
    // 否则运行会永远排队、Job 卡在 running（真机实测：经营数据采集在店铺未打开时卡死）。
    // 只开店不建标签页：TaskRunner 会按第一步 navigate 自己建正确的标签页。
    if (row.store_id && !getOpenStoreIds().includes(row.store_id)) {
      try { openStoreBrowser(row.store_id) } catch { /* 打开失败时任务会如实失败，不阻塞状态机 */ }
    }
    try {
      const run = TaskRunner.enqueueRun(row.browser_task_id, { reason: `Agent Job ${jobId}`, storeId: row.store_id || undefined })
      db.prepare('UPDATE agent_jobs SET browser_run_id=?,updated_at=? WHERE id=?').run(run.runId, now(), jobId)
      return getAgentJob(jobId)
    } catch (error: any) {
      transitionJob(jobId, 'failed', actor.id, 'TaskRunner 未能接受 Job', { code: error?.code || 'TASK_RUN_FAILED' }, ['running'])
      throw error
    }
  }
  // Model-only Jobs stay in Main.  No model output is treated as a tool or
  // permission; only a bounded, hashed result is persisted as evidence.
  return executeModelJob({ ...row, status: 'running', lease_owner: lease }, actor.id)
}

/**
 * Main-owned delegation path for the visible root-ceo chat. The CEO never
 * executes a TaskRunner task itself: this resolves an active child Agent that
 * covers the target store, freezes the job snapshot and (optionally) starts it.
 */
export async function delegateAgentTask(raw: unknown, opts: { userInitiatedCollect?: boolean } = {}): Promise<{ job: any; executor: { id: string; name: string; role: string }; provisioned: boolean; queued: boolean }> {
  const input = agentTaskDelegateSchema.parse(raw)
  const actor = requireRoot(input.actorAgentId)
  const loadOf = (agentId: string): number => Number((getDatabase().prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE assigned_agent_id=? AND status IN ('accepted','running','waiting_confirmation')").get(agentId) as any)?.c || 0)
  // 自治运营：没有可用执行岗时自动创建/激活一个，而不是让任务失败。
  // 写/提交类页面任务只选非只读执行者：只读范围是权限模型的一部分（§4.2/§4.3）。
  // 纯模型任务不接触店铺，按只读处理，不受只读范围过滤。
  const risk = input.browserTask ? deriveJobRisk({ goal: input.goal, inputSummary: { source: 'ceo-chat' }, browserTask: input.browserTask }) : 'read'
  const ensured = ensureExecutorAgent(input.storeId, loadOf, risk)
  const executor = ensured.agent
  const jobInput = agentJobCreateSchema.parse({
    createdByAgentId: actor.id,
    assignedAgentId: executor.id,
    storeId: input.storeId,
    goal: input.goal,
    inputSummary: { source: 'ceo-chat', planId: input.planId },
    priority: 50,
    requiresConfirmation: input.requiresConfirmation,
    idempotencyKey: input.idempotencyKey || `delegate_${payloadHash({ goal: input.goal, storeId: input.storeId, planId: input.planId, browserTask: input.browserTask }).slice(0, 48)}`,
    browserTask: input.browserTask,
    dependencies: []
  })
  const job = createAgentJob(jobInput, { moneyConfirmationSatisfied: opts.userInitiatedCollect === true })
  writeAudit('agent.job.delegate', 'success', { actor: actor.id, storeId: input.storeId, requestId: `${job.id}:${executor.id}` })
  let current = job
  let queued = false
  if (input.run && ['queued', 'accepted'].includes(job.status)) {
    try {
      current = await runAgentJob(job.id, actor.id)
    } catch (error: any) {
      // 执行者并发已满：保留 Job 在队列里，由调度器自动补跑，不当作失败。
      if (error?.code === 'AGENT_CONCURRENCY_LIMIT') {
        queued = true
        current = getAgentJob(job.id)
      } else {
        throw error
      }
    }
  }
  return { job: current, executor: { id: executor.id, name: executor.name, role: executor.role }, provisioned: ensured.provisioned, queued }
}

/**
 * 自治执行岗：优先用 active 子 Agent；没有时创建（或重新激活）独立的“执行助手”。
 * 不主动激活 HR 创建的 probation/paused 子 Agent，避免绕过试用与用户意图。
 */
function ensureExecutorAgent(storeId: string | null, loadOf: (agentId: string) => number, risk: 'read' | 'write' | 'submit' = 'read'): { agent: AgentRecord; provisioned: boolean } {
  const active = selectExecutorAgent(listAgents(), storeId, loadOf, { requireWritable: risk !== 'read' })
  if (active) return { agent: active, provisioned: false }
  const existing = listAgents().find(agent => agent.name === '执行助手' && agent.status !== 'retired')
  if (existing) {
    // 执行助手是自治执行岗（创建时 readOnly=false）。它若是只读，说明被人为改窄；
    // 写任务需要它恢复可写策略——这是 Main 的供给策略，写审计而不是静默扩权。
    let agent = existing
    if (risk !== 'read' && existing.storeScope.readOnly) {
      agent = updateAgent({ actorAgentId: ROOT_AGENT_ID, agentId: existing.id, confirmed: true, storeScope: { ...existing.storeScope, readOnly: false } })
      writeAudit('agent.org.autoprovision', 'success', { actor: ROOT_AGENT_ID, requestId: `widen:${agent.id}:${risk}` })
    }
    const activated = agent.status === 'active' ? agent : activateAgent(agent.id, ROOT_AGENT_ID, true)
    writeAudit('agent.org.autoprovision', 'success', { actor: ROOT_AGENT_ID, requestId: `activate:${activated.id}` })
    return { agent: activated, provisioned: true }
  }
  const created = createAgent({
    actorAgentId: ROOT_AGENT_ID,
    confirmed: true,
    name: '执行助手',
    role: 'operator',
    description: '智能体按自治运营策略自动创建的执行岗位，接收页面任务并通过 TaskRunner 执行',
    storeScope: { storeIds: [], readOnly: false },
    memoryScope: { write: false },
    maxConcurrency: 4
  })
  const agent = activateAgent(created.id, ROOT_AGENT_ID, true)
  writeAudit('agent.org.autoprovision', 'success', { actor: ROOT_AGENT_ID, requestId: `create:${agent.id}` })
  return { agent, provisioned: true }
}

export function approveAgentJob(input: { jobId: string; actorAgentId: string; approved: boolean; confirmationId?: string }): any {
  const actor = requireRoot(input.actorAgentId)
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (row.status !== 'waiting_confirmation') throw new AgentRuntimeError('AGENT_JOB_BAD_STATE', 'Job 当前不在人工确认状态')
  if (row.confirmation_expires_at && Number(row.confirmation_expires_at) <= now()) {
    return transitionJob(row.id, 'expired', actor.id, '人工确认已过期', { confirmationExpired: true }, ['waiting_confirmation'])
  }
  if (row.confirmation_id && input.confirmationId !== row.confirmation_id) throw new AgentRuntimeError('AGENT_CONFIRMATION_INVALID', '人工确认凭证不匹配')
  if (!input.approved) return transitionJob(row.id, 'cancelled', actor.id, '用户拒绝高风险动作', { approved: false }, ['waiting_confirmation'])
  const queued = transitionJob(row.id, 'queued', actor.id, '用户确认高风险动作', { approved: true }, ['waiting_confirmation'], { confirmationApproved: true, confirmationExpiresAt: null })
  return queued
}

export function cancelAgentJob(input: { jobId: string; actorAgentId: string }): any {
  const actor = requireRoot(input.actorAgentId)
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (row.browser_run_id && ['running', 'waiting_confirmation', 'accepted'].includes(row.status)) { try { TaskRunner.cancelRun(row.browser_run_id, 'Agent Job 被用户取消') } catch { /* status transition remains truthful */ } }
  modelJobControllers.get(row.id)?.abort()
  return transitionJob(row.id, 'cancelled', actor.id, row.side_effect_started ? '取消后续步骤；已有页面副作用保留风险记录' : '用户取消 Job', { sideEffectStarted: !!row.side_effect_started }, ['draft', 'delegated', 'queued', 'accepted', 'running', 'waiting_input', 'waiting_confirmation', 'recovery_required', 'blocked_budget', 'blocked_permission'])
}

export function resumeAgentJob(input: { jobId: string; actorAgentId: string }): any {
  const actor = requireRoot(input.actorAgentId)
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (row.side_effect_started) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '已有页面副作用的 Job 必须重新观察并由用户决定，不能自动恢复')
  return transitionJob(row.id, 'queued', actor.id, '用户/CEO 选择安全恢复', null, ['recovery_required', 'failed', 'blocked_budget', 'blocked_permission'])
}

export function markRecoverableJobsOnStartup(): number {
  const db = getDatabase()
  const rows = db.prepare("SELECT id,status,confirmation_expires_at FROM agent_jobs WHERE status IN ('accepted','running','waiting_input','waiting_confirmation')").all() as any[]
  for (const row of rows) {
    try {
      if (row.status === 'waiting_confirmation') {
        if (row.confirmation_expires_at && Number(row.confirmation_expires_at) <= now()) transitionJob(row.id, 'expired', ROOT_AGENT_ID, '应用重启时发现人工确认已过期', { confirmationExpired: true }, ['waiting_confirmation'])
        // A still-valid confirmation remains actionable after restart.
        continue
      }
      transitionJob(row.id, 'recovery_required', ROOT_AGENT_ID, '应用重启后要求人工选择恢复或取消', null, [row.status])
    } catch { /* migration repair is best effort */ }
  }
  return rows.length
}

let agentLeaseTimer: NodeJS.Timeout | null = null
let lastMemoryMaintenanceAt = 0

/**
 * 自治调度：按顺序补跑由智能体派单、因并发上限留在队列里的 Job。
 * 只处理 source=ceo-chat 的排队 Job，不触碰任务面板/手工创建的排队项。
 */
function drainDelegatedQueue(): void {
  const db = getDatabase()
  const rows = db.prepare(`SELECT id, assigned_agent_id FROM agent_jobs
    WHERE status='queued' AND json_extract(input_summary_json, '$.source')='ceo-chat'
    ORDER BY created_at ASC LIMIT 10`).all() as any[]
  for (const row of rows) {
    try {
      const assigned = requireAgent(row.assigned_agent_id)
      if (assigned.status !== 'active') continue
      const running = Number((db.prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE assigned_agent_id=? AND status='running'").get(assigned.id) as any)?.c || 0)
      if (running >= assigned.maxConcurrency) continue
      const jobRow = db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(row.id) as any
      if (!jobRow) continue
      const dependencies = dependencyState(jobRow)
      if (dependencies.waiting.length || dependencies.failed.length || dependencies.missing.length) continue
      void runAgentJob(row.id, ROOT_AGENT_ID).catch(() => undefined)
    } catch { /* 调度失败不影响其他排队 Job */ }
  }
}

function sweepAgentJobs(): void {
  const db = getDatabase()
  const t = now()
  // Keep memory lifecycle maintenance automatic while the Main runtime is
  // alive.  The operation only changes stale/archive metadata and is bounded;
  // it never approves candidates or changes permissions.
  if (t - lastMemoryMaintenanceAt >= 10 * 60 * 1000) {
    lastMemoryMaintenanceAt = t
    void import('./agent-memory').then(({ maintainMemories }) => maintainMemories(t)).catch(() => undefined)
  }
  const leaseMs = getSettingNumber('agent.jobs.leaseMs', 30000, 5000, 300000)
  const maxRunMs = getSettingNumber('agent.jobs.maxRunMs', 1800000, 60000, 21600000)
  const rows = db.prepare("SELECT * FROM agent_jobs WHERE status IN ('running','waiting_confirmation')").all() as any[]
  for (const row of rows) {
    try {
      if (row.status === 'waiting_confirmation') {
        if (row.confirmation_expires_at && Number(row.confirmation_expires_at) <= t) {
          transitionJob(row.id, 'expired', ROOT_AGENT_ID, '人工确认超时，Job 已过期', { confirmationExpired: true }, ['waiting_confirmation'])
        }
        continue
      }
      // 先做状态对账（开店兜底 + 同步 TaskRunner 结果），再判租约：这样"运行其实已经结束"
      // 的 Job 会先被正常收敛，而不会因为租约到点被误判成 recovery_required。
      if (row.browser_run_id) {
        // 兜底：运行排队但店铺未打开时先打开店铺（TaskRunner 只在店铺已打开时启动排队运行）。
        try {
          const browserRun = TaskStore.getRun(row.browser_run_id)
          if (browserRun?.status === 'queued' && row.store_id && !getOpenStoreIds().includes(row.store_id)) {
            openStoreBrowser(row.store_id)
          }
        } catch { /* best effort */ }
        try { syncBrowserJob(row) } catch { /* status is reconciled on the next sweep */ }
      }
      const current = db.prepare('SELECT status,lease_owner,version,lease_expires_at,started_at,browser_run_id FROM agent_jobs WHERE id=?').get(row.id) as any
      if (!current || current.status !== 'running') continue
      // 续租的唯一依据是"还有活着的执行者"（审计 P2-B）：以前这里无条件续租，
      // 于是活进程里卡死的 worker 永不超时；现在没有 live worker 就不再续租，
      // 下一个 tick 由 evaluateLeaseSweep 判过期 → recovery_required 交人工。
      let liveRun = false
      try {
        if (current.browser_run_id) {
          const run = TaskStore.getRun(current.browser_run_id)
          liveRun = !!run && ['queued', 'running', 'paused', 'waiting_confirmation'].includes(String(run.status))
        }
      } catch { liveRun = false }
      const verdict = evaluateLeaseSweep({
        status: String(current.status),
        leaseExpiresAt: current.lease_expires_at == null ? null : Number(current.lease_expires_at),
        startedAt: current.started_at == null ? null : Number(current.started_at),
        now: t,
        leaseMs,
        liveWorker: modelJobControllers.has(row.id) || liveRun,
        maxRunMs
      })
      if (verdict.action === 'expire') {
        if (current.browser_run_id) { try { TaskRunner.cancelRun(current.browser_run_id, 'Agent Job 租约过期，停止后续页面动作') } catch { /* best effort */ } }
        modelJobControllers.get(row.id)?.abort()
        transitionJob(row.id, 'recovery_required', ROOT_AGENT_ID, verdict.message, {
          code: verdict.code,
          leaseExpiredAt: current.lease_expires_at == null ? null : Number(current.lease_expires_at),
          sideEffectStarted: !!row.side_effect_started
        }, ['running'])
        continue
      }
      if (verdict.action === 'renew' && current.lease_owner) {
        db.prepare('UPDATE agent_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND status=\'running\' AND lease_owner=? AND version=?').run(t + leaseMs, t, row.id, current.lease_owner, current.version)
      }
    } catch { /* a stale worker must never crash the main process */ }
  }
  drainDelegatedQueue()
}

export function startAgentRuntimeLeaseSweeper(): void {
  if (agentLeaseTimer) return
  const interval = getSettingNumber('agent.jobs.heartbeatMs', 10000, 1000, 60000)
  agentLeaseTimer = setInterval(sweepAgentJobs, interval)
  agentLeaseTimer.unref?.()
}

export function qualityMetrics(): Record<string, unknown> {
  const db = getDatabase()
  const total = Number((db.prepare('SELECT COUNT(*) c FROM agent_jobs').get() as any).c || 0)
  const succeeded = Number((db.prepare("SELECT COUNT(*) c FROM agent_jobs WHERE status='succeeded'").get() as any).c || 0)
  const firstSuccess = Number((db.prepare("SELECT COUNT(*) c FROM agent_jobs WHERE status='succeeded' AND attempt_count=1").get() as any).c || 0)
  const feedback = Number((db.prepare('SELECT COUNT(*) c FROM agent_feedback').get() as any).c || 0)
  const corrections = Number((db.prepare('SELECT COUNT(*) c FROM agent_feedback WHERE correction IS NOT NULL AND length(trim(correction)) > 0').get() as any).c || 0)
  const approvedMemory = Number((db.prepare("SELECT COUNT(*) c FROM agent_memory_records WHERE status='approved'").get() as any).c || 0)
  const fallbackCount = Number((db.prepare("SELECT COUNT(*) c FROM agent_job_results WHERE json_extract(evidence_json, '$.fallbackUsed') = 1").get() as any).c || 0)
  const budgetBlocked = Number((db.prepare("SELECT COUNT(*) c FROM agent_jobs WHERE status='blocked_budget'").get() as any).c || 0)
  const memoryGovernance = { stale: 0, conflict: 0, hitCount: 0, adoptionCount: 0, rejectionCount: 0, autoCandidates: 0, archived: 0, adaptiveConfidence: 0 }
  try {
    const rows = db.prepare("SELECT status,COUNT(*) c FROM agent_memory_records WHERE status IN ('stale','conflict') GROUP BY status").all() as any[]
    for (const row of rows) memoryGovernance[String(row.status) as 'stale' | 'conflict'] = Number(row.c || 0)
    for (const row of db.prepare("SELECT event_type,COUNT(*) c FROM agent_memory_events GROUP BY event_type").all() as any[]) {
      if (row.event_type === 'hit') memoryGovernance.hitCount = Number(row.c || 0)
      if (row.event_type === 'adopted') memoryGovernance.adoptionCount = Number(row.c || 0)
      if (row.event_type === 'rejected') memoryGovernance.rejectionCount = Number(row.c || 0)
    }
    memoryGovernance.autoCandidates = Number((db.prepare("SELECT COUNT(*) c FROM agent_memory_records WHERE origin<>'manual' AND status IN ('pending-review','conflict','quarantined')").get() as any)?.c || 0)
    memoryGovernance.archived = Number((db.prepare("SELECT COUNT(*) c FROM agent_memory_records WHERE archived_at IS NOT NULL").get() as any)?.c || 0)
    memoryGovernance.adaptiveConfidence = Number((db.prepare("SELECT COALESCE(AVG(confidence),0) c FROM agent_memory_records WHERE status='approved'").get() as any)?.c || 0)
  } catch { /* migration v6 will create the optional governance table */ }
  const profileHealth = (db.prepare('SELECT health,COUNT(*) c FROM agent_model_profiles GROUP BY health').all() as any[]).reduce((out, row) => ({ ...out, [String(row.health)]: Number(row.c || 0) }), {})
  return {
    totalJobs: total,
    successRate: total ? succeeded / total : 0,
    firstSuccessRate: total ? firstSuccess / total : 0,
    manualCorrectionRate: feedback ? corrections / feedback : 0,
    feedbackCount: feedback,
    fallbackCount,
    budgetBlocked,
    approvedMemoryCount: approvedMemory,
    memoryHitCount: memoryGovernance.hitCount,
    memoryAdoptionCount: memoryGovernance.adoptionCount,
    memoryRejectionCount: memoryGovernance.rejectionCount,
    memoryAutoCandidateCount: memoryGovernance.autoCandidates,
    archivedMemoryCount: memoryGovernance.archived,
    adaptiveMemoryConfidence: memoryGovernance.adaptiveConfidence,
    staleMemoryCount: memoryGovernance.stale,
    conflictMemoryCount: memoryGovernance.conflict,
    profileHealth,
    generatedAt: now()
  }
}

/**
 * Generate a bounded CEO review snapshot from persisted evidence. Automatic
 * governance only marks expired candidates stale; it never changes policy,
 * permissions, model bindings, or security rules.
 */
export async function qualityReviewSummary(actorAgentId = ROOT_AGENT_ID): Promise<Record<string, unknown>> {
  const actor = requireRoot(actorAgentId)
  const db = getDatabase()
  const periodEnd = now()
  const periodStart = periodEnd - 7 * 24 * 60 * 60 * 1000
  // 记忆治理只有一处实现（过期 / 低置信度 / 近重复收敛 / 保留期归档）。
  // 这里以前复刻了一份治理 SQL，规则一改两边就会漂移；改用 maintainMemories。
  // 必须用动态 import：agent-memory 反向静态依赖本模块，且打包后相对 require 会
  // MODULE_NOT_FOUND（该模块已被 rollup 内联进 index.js）。
  const { maintainMemories } = await import('./agent-memory')
  const memoryGovernance = maintainMemories(periodEnd)
  const metrics = qualityMetrics()
  const usage = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(CASE WHEN estimated=1 THEN 1 ELSE 0 END),0) AS estimatedCalls
    FROM agent_usage WHERE created_at>=? AND created_at<=?`).get(periodStart, periodEnd) as { calls: number; inputTokens: number; outputTokens: number; estimatedCalls: number } | undefined
  const costRows = db.prepare('SELECT cost_json FROM agent_usage WHERE created_at>=? AND created_at<=? AND cost_json IS NOT NULL').all(periodStart, periodEnd) as { cost_json: string }[]
  const knownCosts = costRows
    .map(row => parseJson<{ amount?: number; currency?: string } | null>(row.cost_json, null))
    .filter((item): item is { amount: number; currency?: string } => !!item && typeof item.amount === 'number')
  // Currency safety: configured prices may use different currencies. Summing
  // them into one number would be a lie, so mixed currencies stay unreported
  // and are exposed per currency instead.
  const costByCurrency: Record<string, number> = {}
  for (const item of knownCosts) {
    const currency = String(item.currency || 'unspecified')
    costByCurrency[currency] = Number(((costByCurrency[currency] || 0) + Number(item.amount || 0)).toFixed(12))
  }
  const costCurrencies = Object.keys(costByCurrency)
  const mixedCurrency = costCurrencies.length > 1
  const knownCost = knownCosts.length && !mixedCurrency ? costByCurrency[costCurrencies[0]] : null
  const costStatus = knownCosts.length === 0 ? 'unestimated_without_price' : mixedCurrency ? 'mixed_currency' : 'provider_or_configured_cost'
  const pendingMemoryReview = Number((db.prepare("SELECT COUNT(*) AS c FROM agent_memory_records WHERE status IN ('pending-review','conflict','quarantined') AND archived_at IS NULL").get() as { c: number } | undefined)?.c || 0)
  const blockedJobs = Number((db.prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE status IN ('blocked_budget','blocked_permission','recovery_required')").get() as { c: number } | undefined)?.c || 0)
  const summary = {
    periodStart,
    periodEnd,
    generatedAt: periodEnd,
    metrics,
    usage: {
      calls: Number(usage?.calls || 0),
      inputTokens: Number(usage?.inputTokens || 0),
      outputTokens: Number(usage?.outputTokens || 0),
      estimatedCalls: Number(usage?.estimatedCalls || 0),
      estimatedCost: knownCost,
      costStatus,
      costByCurrency
    },
    governance: { expiredMarkedStale: memoryGovernance.expired, lowConfidenceMarkedStale: memoryGovernance.lowConfidence, archived: memoryGovernance.archived, consolidated: memoryGovernance.consolidated, pendingMemoryReview, blockedJobs },
    sources: ['agent_jobs', 'agent_usage', 'agent_job_results', 'agent_feedback', 'agent_memory_records', 'agent_memory_events'],
    requiresHumanReview: pendingMemoryReview > 0 || blockedJobs > 0
  }
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('agent.quality.lastReview', json(summary), periodEnd)
  writeAudit('agent.quality.review', 'success', { actor: actor.id, requestId: `${periodStart}:${periodEnd}` })
  return summary
}

export function reviewAgentJobResult(raw: AgentJobResultReview): any {
  const input = agentJobResultReviewSchema.parse(raw)
  const reviewer = requireAgent(input.reviewerAgentId)
  if (reviewer.id !== ROOT_AGENT_ID && !reviewer.toolPolicy.tools.includes('review_job')) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有审核 Job 结果的权限')
  const row = getDatabase().prepare('SELECT r.id,r.job_id FROM agent_job_results r WHERE r.id=?').get(input.resultId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_RESULT_NOT_FOUND', 'Job 结果不存在')
  getDatabase().prepare('UPDATE agent_job_results SET approved=?,reviewer_agent_id=? WHERE id=?').run(input.approved ? 1 : 0, reviewer.id, input.resultId)
  if (input.correction) {
    getDatabase().prepare('INSERT INTO agent_feedback(id,job_id,memory_id,reviewer_agent_id,rating,correction,created_at) VALUES (?,?,?,?,?,?,?)').run(`afb_${randomUUID()}`, row.job_id, null, reviewer.id, input.approved ? 5 : 1, redactAgentText(input.correction, 1000), now())
    void import('./agent-memory').then(({ learnFromFeedback }) => learnFromFeedback({ jobId: row.job_id, reviewerAgentId: reviewer.id, correction: input.correction! })).catch(() => undefined)
  }
  writeAudit('agent.job.result.review', 'success', { actor: reviewer.id, requestId: input.resultId })
  return getAgentJob(row.job_id)
}

export async function addJobFeedback(raw: AgentJobFeedback): Promise<void> {
  const input = agentJobFeedbackSchema.parse(raw)
  const reviewer = requireAgent(input.reviewerAgentId)
  if (reviewer.id !== ROOT_AGENT_ID && !reviewer.toolPolicy.tools.includes('review_job')) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有提交 Job 反馈的权限')
  if (!getDatabase().prepare('SELECT id FROM agent_jobs WHERE id=?').get(input.jobId)) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (input.memoryId) {
    // Validate the relation and reviewer scope before recording feedback. The
    // asynchronous learner below is best effort, but the permission boundary
    // must complete before the insert and cannot be bypassed by a forged memory id.
    // 这里用 await import 而不是 require：打包产物中相对 require 会 MODULE_NOT_FOUND。
    const { assertMemoryFeedbackAllowed } = await import('./agent-memory')
    assertMemoryFeedbackAllowed({ memoryId: input.memoryId, agentId: reviewer.id, jobId: input.jobId })
  }
  getDatabase().prepare('INSERT INTO agent_feedback(id,job_id,memory_id,reviewer_agent_id,rating,correction,created_at) VALUES (?,?,?,?,?,?,?)').run(`afb_${randomUUID()}`, input.jobId, input.memoryId || null, reviewer.id, input.rating, input.correction ? redactAgentText(input.correction, 1000) : null, now())
  if (input.memoryId) {
    void import('./agent-memory').then(({ recordMemoryFeedback }) => recordMemoryFeedback({ memoryId: input.memoryId!, agentId: reviewer.id, jobId: input.jobId, rating: input.rating })).catch(() => undefined)
  }
  if (input.correction) {
    void import('./agent-memory').then(({ learnFromFeedback }) => learnFromFeedback({ jobId: input.jobId, reviewerAgentId: reviewer.id, correction: input.correction! })).catch(() => undefined)
  }
  writeAudit('agent.feedback.create', 'success', { actor: reviewer.id, requestId: input.jobId })
}

// Keep schema imports exercised by the runtime boundary and prevent accidental
// widening of future renderer payloads.
export { agentBindingInputSchema, agentJobActionSchema, agentMemoryScopeSchema }
