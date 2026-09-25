import { z } from 'zod'

/** Shared contracts for the multi-agent runtime.  These schemas are closed on
 * purpose: model output and renderer input must never introduce an operation
 * that Main did not explicitly approve. */

export const AGENT_STATUSES = ['probation', 'active', 'paused', 'retired'] as const
export const AGENT_ROLES = ['ceo', 'operator', 'reviewer', 'analyst', 'content', 'support'] as const
export const AGENT_JOB_STATUSES = [
  'draft', 'delegated', 'queued', 'accepted', 'running', 'waiting_input',
  'waiting_confirmation', 'succeeded', 'failed', 'cancelled', 'recovery_required',
  'expired', 'blocked_budget', 'blocked_permission'
] as const
export const AGENT_MEMORY_TYPES = ['semantic', 'procedural', 'episodic', 'shared'] as const
export const AGENT_MEMORY_STATUSES = ['pending-review', 'approved', 'stale', 'conflict', 'quarantined'] as const
export const AGENT_MEMORY_SENSITIVITY = ['low', 'internal', 'private'] as const

export const agentToolPolicySchema = z.object({
  canCreateAgent: z.boolean().default(false),
  canChangeModel: z.boolean().default(false),
  canChangePolicy: z.boolean().default(false),
  canReadOtherAgentPrivateMemory: z.boolean().default(false),
  canUseShell: z.literal(false).default(false),
  canReadCredentials: z.literal(false).default(false),
  tools: z.array(z.enum([
    'observe_page', 'read_text', 'read_table', 'model_analyze', 'create_job',
    'review_job', 'memory_search', 'memory_write'
  ])).max(32).default([])
}).strict()

export const agentScopeSchema = z.object({
  storeIds: z.array(z.string().min(1).max(80)).max(200).default([]),
  readOnly: z.boolean().default(true)
}).strict()

export const agentMemoryScopeSchema = z.object({
  agentIds: z.array(z.string().min(1).max(80)).max(200).default([]),
  storeIds: z.array(z.string().min(1).max(80)).max(200).default([]),
  includeShared: z.boolean().default(false),
  write: z.boolean().default(false)
}).strict()

export const agentRecordSchema = z.object({
  id: z.string().min(1).max(80),
  parentId: z.string().max(80).nullable(),
  name: z.string().min(1).max(120),
  role: z.enum(AGENT_ROLES),
  description: z.string().max(1000),
  status: z.enum(AGENT_STATUSES),
  promptVersion: z.string().min(1).max(40),
  modelProfileId: z.string().max(80).nullable(),
  toolPolicy: agentToolPolicySchema,
  storeScope: agentScopeSchema,
  memoryScope: agentMemoryScopeSchema,
  maxConcurrency: z.number().int().min(1).max(32),
  dailyBudget: z.object({ currency: z.string().max(8), amount: z.number().nonnegative() }).strict().nullable(),
  timeoutMs: z.number().int().min(1000).max(3600000),
  successCriteria: z.array(z.string().max(300)).max(20),
  createdByAgentId: z.string().max(80).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  retiredAt: z.number().int().nonnegative().nullable()
}).strict()

export const modelCapabilitiesSchema = z.object({
  chat: z.boolean().default(true),
  json: z.boolean().default(false),
  vision: z.boolean().default(false),
  cancellation: z.boolean().default(true)
}).strict()

/** 服务商价格：币种 + 每百万 token 的输入/输出单价。留空时成本一律显示“未估算”。 */
export const modelPricingSchema = z.object({
  currency: z.string().trim().min(1).max(8),
  inputPerMTok: z.number().nonnegative().max(1000000),
  outputPerMTok: z.number().nonnegative().max(1000000)
}).strict()

export const modelProfileSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(80),
  endpoint: z.string().url().max(500),
  model: z.string().min(1).max(160),
  hasKey: z.boolean(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(16).max(128000),
  timeoutMs: z.number().int().min(1000).max(3600000),
  fallbackProfileId: z.string().max(80).nullable(),
  capabilities: modelCapabilitiesSchema,
  concurrencyLimit: z.number().int().min(1).max(64),
  dailyBudget: z.object({ currency: z.string().max(8), amount: z.number().nonnegative() }).strict().nullable(),
  pricing: modelPricingSchema.nullable().default(null),
  enabled: z.boolean(),
  health: z.enum(['unknown', 'healthy', 'degraded', 'disabled']),
  updatedAt: z.number().int().nonnegative()
}).strict()

export const modelProfileInputSchema = z.object({
  id: z.string().regex(/^model_[a-z0-9-]{8,80}$/).optional(),
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(80),
  endpoint: z.string().url().max(500),
  model: z.string().trim().min(1).max(160),
  apiKey: z.string().min(8).max(4096).optional(),
  clearKey: z.boolean().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(16).max(128000).default(1200),
  timeoutMs: z.number().int().min(1000).max(3600000).default(30000),
  fallbackProfileId: z.string().max(80).nullable().default(null),
  capabilities: modelCapabilitiesSchema.default({}),
  concurrencyLimit: z.number().int().min(1).max(64).default(1),
  dailyBudget: z.object({ currency: z.string().max(8), amount: z.number().nonnegative() }).strict().nullable().default(null),
  pricing: modelPricingSchema.nullable().default(null),
  enabled: z.boolean().default(true)
}).strict()

export const agentBindingInputSchema = z.object({
  agentId: z.string().min(1).max(80),
  modelProfileId: z.string().min(1).max(80).nullable()
}).strict()

/** HR is a controlled mode of root-ceo, never a second hidden root agent. */
export const agentHrPreviewSchema = z.object({
  mode: z.literal('hr'),
  role: z.enum(['operator', 'reviewer', 'analyst', 'content', 'support']).default('operator'),
  actorAgentId: z.string().min(1).max(80).default('root-ceo')
}).strict()

export const jobPrioritySchema = z.number().int().min(0).max(100).default(50)
export const agentJobCreateSchema = z.object({
  parentJobId: z.string().max(80).nullable().default(null),
  createdByAgentId: z.string().min(1).max(80),
  assignedAgentId: z.string().min(1).max(80),
  storeId: z.string().max(80).nullable().default(null),
  goal: z.string().trim().min(1).max(2000),
  inputSummary: z.record(z.unknown()).default({}),
  priority: jobPrioritySchema,
  requiresConfirmation: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(180),
  /** Optional definition for the existing Main-only TaskRunner. */
  browserTask: z.object({
    name: z.string().min(1).max(160),
    storeScope: z.string().max(80).nullable().default(null),
    steps: z.array(z.record(z.unknown())).min(1).max(25)
  }).strict().nullable().default(null),
  dependencies: z.array(z.string().min(1).max(80)).max(12).default([])
}).strict()

export const agentJobActionSchema = z.object({
  jobId: z.string().min(1).max(80),
  actorAgentId: z.string().min(1).max(80),
  confirmationId: z.string().max(120).nullable().optional()
}).strict()

/**
 * 主 Agent 派单输入。root-ceo 不执行任务：Main 只接受“派给子 Agent”，
 * 执行者从这里给出的店铺范围外的候选中自动选择。
 */
export const agentTaskDelegateSchema = z.object({
  actorAgentId: z.string().min(1).max(80).default('root-ceo'),
  goal: z.string().trim().min(1).max(2000),
  storeId: z.string().min(1).max(80),
  planId: z.string().max(80).nullable().default(null),
  requiresConfirmation: z.boolean().default(false),
  run: z.boolean().default(true),
  browserTask: z.object({
    name: z.string().min(1).max(160),
    storeScope: z.string().max(80).nullable().default(null),
    steps: z.array(z.record(z.unknown())).min(1).max(25)
  }).strict(),
  idempotencyKey: z.string().trim().min(8).max(180).optional()
}).strict()

export const agentJobResultReviewSchema = z.object({
  resultId: z.string().min(1).max(100),
  reviewerAgentId: z.string().min(1).max(80),
  approved: z.boolean(),
  correction: z.string().max(1000).nullable().optional()
}).strict()

export const agentJobFeedbackSchema = z.object({
  jobId: z.string().min(1).max(80),
  memoryId: z.string().max(100).nullable().optional(),
  reviewerAgentId: z.string().min(1).max(80),
  rating: z.number().int().min(1).max(5),
  correction: z.string().max(1000).nullable().optional()
}).strict()

export const agentJobListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).nullable().default(null),
  status: z.enum(AGENT_JOB_STATUSES).nullable().default(null),
  assignedAgentId: z.string().max(80).nullable().default(null),
  storeId: z.string().max(80).nullable().default(null)
}).strict()

export const agentOrgListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(240).nullable().default(null)
}).strict()

export const modelProfileListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(240).nullable().default(null),
  enabled: z.boolean().nullable().default(null)
}).strict()

export const agentMemoryWriteSchema = z.object({
  agentId: z.string().min(1).max(80),
  storeId: z.string().max(80).nullable().default(null),
  scope: z.enum(['private', 'store', 'shared']),
  type: z.enum(AGENT_MEMORY_TYPES),
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(32768),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceJobId: z.string().max(80).nullable().default(null),
  sensitivity: z.enum(AGENT_MEMORY_SENSITIVITY).default('internal'),
  expiresAt: z.number().int().positive().nullable().default(null)
}).strict()

export const agentMemoryListQuerySchema = z.object({
  agentId: z.string().min(1).max(80),
  storeId: z.string().max(80).nullable().default(null),
  status: z.enum(AGENT_MEMORY_STATUSES).nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).nullable().default(null)
}).strict()

export const agentMemorySearchSchema = z.object({
  agentId: z.string().min(1).max(80),
  query: z.string().trim().min(1).max(300),
  storeId: z.string().max(80).nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20)
}).strict()

export const agentMemoryReviewSchema = z.object({
  memoryId: z.string().min(1).max(100),
  status: z.enum(['approved', 'stale', 'quarantined']),
  reviewerAgentId: z.string().min(1).max(80)
}).strict()

export const paginationResultSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
}).strict()

export type AgentRecord = z.infer<typeof agentRecordSchema>
export type ModelProfile = z.infer<typeof modelProfileSchema>
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>
export type ModelPricing = z.infer<typeof modelPricingSchema>
export type AgentJobCreate = z.infer<typeof agentJobCreateSchema>
export type AgentTaskDelegate = z.infer<typeof agentTaskDelegateSchema>
export type AgentJobAction = z.infer<typeof agentJobActionSchema>
export type AgentJobResultReview = z.infer<typeof agentJobResultReviewSchema>
export type AgentJobFeedback = z.infer<typeof agentJobFeedbackSchema>
export type AgentMemoryWrite = z.infer<typeof agentMemoryWriteSchema>
export type AgentMemoryReview = z.infer<typeof agentMemoryReviewSchema>

export const ROOT_AGENT_ID = 'root-ceo'
export const DEFAULT_AGENT_TOOL_POLICY = agentToolPolicySchema.parse({
  canCreateAgent: true,
  canChangeModel: true,
  canChangePolicy: true,
  canReadOtherAgentPrivateMemory: true,
  tools: ['observe_page', 'read_text', 'read_table', 'model_analyze', 'create_job', 'review_job', 'memory_search', 'memory_write']
})

export const DEFAULT_AGENT_MEMORY_SCOPE = agentMemoryScopeSchema.parse({
  agentIds: [ROOT_AGENT_ID], includeShared: true, write: true
})
