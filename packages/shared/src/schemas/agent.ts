import { z } from 'zod'

/** Agent 只允许产出可以映射到 TaskRunner 白名单的受控步骤。 */
export const AGENT_STEP_TYPES = [
  'useTab',
  'navigate',
  'waitForPage',
  'waitForSelector',
  'readText',
  'readTable',
  'readLabelValue',
  'waitMs',
  'waitForGone',
  'click',
  'clickByText',
  'waitForUserConfirmation'
] as const

export const AGENT_PROPOSAL_STEP_TYPES = [
  'navigate',
  'waitForPage',
  'waitForSelector',
  'readText',
  'readTable',
  'readLabelValue',
  'waitMs',
  'waitForGone',
  'click',
  'clickByText'
] as const

export const AGENT_PLAN_STATUSES = [
  'draft', 'validated', 'created', 'running', 'waiting_confirmation',
  'succeeded', 'failed', 'cancelled'
] as const

/** 软件级 Agent 只允许调用这些已有应用能力；没有文件、Shell、脚本或源码操作。 */
export const AGENT_SOFTWARE_ACTION_TYPES = [
  'listStores',
  'listTasks',
  'listAgents',
  'listJobs',
  'listTrashStores',
  'listBackups',
  'getTaskDetail',
  'searchMemory',
  'openStore',
  'displayStore',
  'activateTab',
  'closeStore',
  'createAgent',
  'activateAgent',
  'pauseAgent',
  'resumeAgent',
  'retireAgent',
  'openPanel',
  'createStore',
  'updateStore',
  'archiveStore',
  'restoreStore',
  'deleteStorePermanent',
  'deleteTask',
  'runTask',
  'cancelTaskRun',
  'pauseTaskRun',
  'resumeTaskRun',
  'collectInvoices',
  'collectBusiness',
  'collectEntity',
  'collectOrders',
  'listDownloads',
  'listBookmarks',
  'createBookmark',
  'deleteBookmark',
  'createBackup',
  'restoreBackup',
  'writeMemory',
  'listTools',
  'listSkills',
  'createSkill',
  'runSkill',
  'deleteSkill',
  'createPlugin',
  'listPlugins',
  'runInvite'
] as const

/** 主 Agent 可以打开的应用面板；不包含任何数据写入。 */
export const AGENT_SOFTWARE_PANELS = ['settings', 'agentTeam', 'aiConfig', 'tasks', 'invoiceCenter', 'dataCenter'] as const

/** 允许通过对话创建的子 Agent 岗位。 */
export const AGENT_CREATABLE_ROLES = ['operator', 'analyst', 'reviewer', 'content', 'support'] as const

export const AGENT_RISK_LEVELS = ['read', 'write', 'submit'] as const

export const AGENT_MAX_GOAL_CHARS = 500
export const AGENT_MAX_PROPOSAL_STEPS = 12
export const AGENT_MAX_PLAN_STEPS = 25
export const AGENT_MAX_TEXT_CHARS = 2000
export const AGENT_MAX_TIMEOUT_MS = 120000

export const agentScheduleSchema = z.object({
  everyMs: z.number().int().min(60000).max(30 * 86400000)
}).strict()

export const agentPageButtonSchema = z.object({
  text: z.string().min(1).max(160),
  selector: z.string().max(500).nullable()
}).strict()

export const agentPageInputSchema = z.object({
  label: z.string().max(120),
  type: z.string().max(30),
  selector: z.string().max(500).nullable()
}).strict()

export const agentPageTableSchema = z.object({
  selector: z.string().min(1).max(500),
  headers: z.array(z.string().max(100)).max(20),
  rowCount: z.number().int().min(0).max(1000000)
}).strict()

export const agentPageObservationSchema = z.object({
  storeId: z.string().min(1).max(80),
  storeName: z.string().min(1).max(120),
  storePlatform: z.string().min(1).max(80),
  tabId: z.string().min(1).max(100),
  tabTitle: z.string().max(240),
  currentUrl: z.string().max(500),
  pageTitle: z.string().max(240),
  visibleTextSummary: z.string().max(2400),
  buttons: z.array(agentPageButtonSchema).max(40),
  inputs: z.array(agentPageInputSchema).max(30),
  tables: z.array(agentPageTableSchema).max(8),
  selectorCandidates: z.array(z.string().min(1).max(500)).max(60),
  interactive: z.boolean(),
  screenshot: z.object({
    ref: z.string().min(1).max(80),
    capturedAt: z.number().int().nonnegative(),
    available: z.boolean(),
    dataUrl: z.string().max(1500000).nullable(),
    errorCode: z.string().max(80).nullable()
  }).strict()
}).strict()

export const agentStoreSummarySchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  platform: z.string().min(1).max(80),
  status: z.string().max(40),
  isOpen: z.boolean(),
  isDisplayed: z.boolean(),
  activeTabId: z.string().max(100).nullable(),
  tabs: z.array(z.object({
    id: z.string().min(1).max(100),
    title: z.string().max(240),
    url: z.string().max(500),
    isActive: z.boolean()
  }).strict()).max(30)
}).strict()

export const agentTaskSummarySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  storeScope: z.string().max(80).nullable(),
  status: z.string().max(40),
  latestRun: z.object({
    id: z.string().min(1).max(100),
    status: z.string().max(40),
    storeId: z.string().max(80),
    currentStep: z.number().int().nullable(),
    errorCode: z.string().max(80).nullable()
  }).strict().nullable()
}).strict()

/** 软件级上下文里的子 Agent 摘要：只含身份、岗位、状态和模型绑定，不含提示词或私有记忆。 */
export const agentSoftwareAgentSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  role: z.string().max(40),
  status: z.string().max(40),
  modelProfileId: z.string().max(80).nullable()
}).strict()

/** 软件级上下文里的 Job 摘要：目标已脱敏，证据只给数量。 */
export const agentSoftwareJobSchema = z.object({
  id: z.string().min(1).max(80),
  goal: z.string().max(200),
  status: z.string().max(40),
  assignedAgentId: z.string().max(80),
  risk: z.string().max(20),
  resultCount: z.number().int().min(0).max(1000),
  createdAt: z.number().int().nonnegative()
}).strict()

/** 回收站店铺摘要（可恢复/彻底删除）。 */
export const agentSoftwareTrashStoreSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  platform: z.string().max(80)
}).strict()

/** 软件级上下文里的技能摘要：AI 可据此选择 runSkill。 */
export const agentSoftwareSkillSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(80),
  description: z.string().max(500),
  stepCount: z.number().int().min(0).max(20)
}).strict()

/** 技能步骤：一条闭合工具的调用（type + input）。 */
export const agentSkillStepSchema = z.object({
  type: z.string().min(1).max(60),
  input: z.record(z.unknown()).default({}),
  description: z.string().max(160).default('')
}).strict()

export const agentSkillSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  intent: z.string().max(500),
  steps: z.array(agentSkillStepSchema).max(8),
  status: z.enum(['enabled', 'disabled']),
  source: z.enum(['user', 'ai']),
  pluginId: z.string().max(80).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict()

/** 插件：一组技能的打包（声明式，不含代码）。 */
export const agentPluginSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  skillIds: z.array(z.string().min(1).max(80)).max(8),
  source: z.enum(['user', 'ai']),
  createdAt: z.number().int().nonnegative()
}).strict()

/** 技能/插件分享包（JSON）：只含声明式定义，导入时逐条重新校验。 */
export const AGENT_PACK_FORMAT = 'shopilot-agent-pack'
export const AGENT_PACK_VERSION = 1
export const agentPackSkillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  intent: z.string().trim().max(500).default(''),
  status: z.enum(['enabled', 'disabled']).default('enabled'),
  steps: z.array(z.object({ type: z.string().min(1).max(60), input: z.record(z.unknown()).default({}) }).strict()).min(1).max(8)
}).strict()
export const agentPackPluginSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  /** 引用包内或本地已有技能的名称。 */
  skills: z.array(z.string().trim().min(1).max(80)).min(1).max(8)
}).strict()
export const agentPackSchema = z.object({
  format: z.literal(AGENT_PACK_FORMAT),
  version: z.literal(AGENT_PACK_VERSION),
  exportedAt: z.number().int().nonnegative().default(0),
  skills: z.array(agentPackSkillSchema).max(50),
  plugins: z.array(agentPackPluginSchema).max(20)
}).strict()
export const agentPackExportInputSchema = z.object({
  skillNames: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  includeDisabled: z.boolean().default(true)
}).strict()
export const agentPackImportInputSchema = z.object({
  json: z.string().min(2).max(200000),
  confirmed: z.boolean().default(false)
}).strict()

/** 本地备份摘要：只给 id、时间、大小和恢复状态，不带文件路径。 */
export const agentSoftwareBackupSchema = z.object({
  id: z.string().min(1).max(100),
  createdAt: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  restoreStatus: z.string().max(40).nullable()
}).strict()

/** 软件级上下文只包含应用对象摘要，不包含 WebContents、Cookie、Token、密码或文件路径。 */
export const agentSoftwareContextSchema = z.object({
  displayedStoreId: z.string().max(80).nullable(),
  activeTab: z.object({
    storeId: z.string().min(1).max(80),
    storeName: z.string().min(1).max(120),
    tabId: z.string().min(1).max(100),
    title: z.string().max(240),
    url: z.string().max(500)
  }).strict().nullable(),
  stores: z.array(agentStoreSummarySchema).max(100),
  recentTasks: z.array(agentTaskSummarySchema).max(40),
  agents: z.array(agentSoftwareAgentSchema).max(50).default([]),
  jobs: z.array(agentSoftwareJobSchema).max(20).default([]),
  skills: z.array(agentSoftwareSkillSchema).max(20).default([]),
  trashStores: z.array(agentSoftwareTrashStoreSchema).max(50).default([]),
  backups: z.array(agentSoftwareBackupSchema).max(20).default([]),
  appLocked: z.boolean()
}).strict()

const agentStoreIdSchema = z.string().min(1).max(80)
const agentTabIdSchema = z.string().min(1).max(100)

/** Renderer 和模型都只能提交此闭合联合，不能传入任意命令或代码。 */
export const agentSoftwareActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('listStores') }).strict(),
  z.object({ type: z.literal('listTasks') }).strict(),
  z.object({ type: z.literal('listAgents') }).strict(),
  z.object({ type: z.literal('listJobs') }).strict(),
  z.object({ type: z.literal('openStore'), storeId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('displayStore'), storeId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('activateTab'), storeId: agentStoreIdSchema, tabId: agentTabIdSchema }).strict(),
  z.object({ type: z.literal('closeStore'), storeId: agentStoreIdSchema }).strict(),
  z.object({
    type: z.literal('createAgent'),
    role: z.enum(AGENT_CREATABLE_ROLES),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default('')
  }).strict(),
  z.object({ type: z.literal('activateAgent'), agentId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('pauseAgent'), agentId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('resumeAgent'), agentId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('retireAgent'), agentId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('openPanel'), panel: z.enum(AGENT_SOFTWARE_PANELS) }).strict(),
  z.object({ type: z.literal('listTrashStores') }).strict(),
  z.object({ type: z.literal('listBackups') }).strict(),
  z.object({ type: z.literal('getTaskDetail'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('searchMemory'), query: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('createStore'), name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(80) }).strict(),
  z.object({
    type: z.literal('updateStore'),
    storeId: agentStoreIdSchema,
    name: z.string().trim().min(1).max(120).optional(),
    groupName: z.string().trim().max(80).nullable().optional()
  }).strict(),
  z.object({ type: z.literal('archiveStore'), storeId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('restoreStore'), storeId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('deleteStorePermanent'), storeId: agentStoreIdSchema }).strict(),
  z.object({ type: z.literal('deleteTask'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('runTask'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('cancelTaskRun'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('pauseTaskRun'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('resumeTaskRun'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('listDownloads'), storeId: agentStoreIdSchema.optional() }).strict(),
  z.object({ type: z.literal('listBookmarks'), storeId: agentStoreIdSchema.optional() }).strict(),
  z.object({ type: z.literal('createBookmark'), storeId: agentStoreIdSchema, title: z.string().trim().min(1).max(120), url: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('deleteBookmark'), bookmarkId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('collectInvoices'), storeIds: z.array(agentStoreIdSchema).max(50).default([]) }).strict(),
  z.object({ type: z.literal('collectBusiness'), storeIds: z.array(agentStoreIdSchema).max(50).default([]) }).strict(),
  z.object({ type: z.literal('collectEntity'), storeIds: z.array(agentStoreIdSchema).max(50).default([]) }).strict(),
  z.object({ type: z.literal('collectOrders'), storeIds: z.array(agentStoreIdSchema).max(50).default([]) }).strict(),
  z.object({ type: z.literal('createBackup'), label: z.string().trim().max(80).default('') }).strict(),
  z.object({ type: z.literal('restoreBackup'), backupId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('writeMemory'), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(8000) }).strict(),
  z.object({ type: z.literal('listTools') }).strict(),
  z.object({ type: z.literal('listSkills') }).strict(),
  z.object({
    type: z.literal('createSkill'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    intent: z.string().trim().max(500).default(''),
    steps: z.array(z.object({ type: z.string().min(1).max(60), input: z.record(z.unknown()).default({}) }).strict()).min(1).max(8)
  }).strict(),
  z.object({ type: z.literal('runSkill'), skillId: z.string().max(80).optional(), skillName: z.string().max(80).optional() }).strict(),
  z.object({ type: z.literal('deleteSkill'), skillId: z.string().min(1).max(80) }).strict(),
  z.object({
    type: z.literal('createPlugin'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    skillIds: z.array(z.string().min(1).max(80)).min(1).max(8)
  }).strict(),
  z.object({ type: z.literal('listPlugins') }).strict(),
  /** 达人邀约发送：按店铺已保存的邀约配置构造任务并派给子 Agent（提交类，按自治策略执行）。 */
  z.object({ type: z.literal('runInvite'), storeId: z.string().max(80).optional(), count: z.number().int().min(1).max(50).optional() }).strict()
])

export const agentSoftwarePlanStepSchema = z.object({
  id: z.string().min(1).max(80),
  action: agentSoftwareActionSchema,
  description: z.string().min(1).max(160),
  risk: z.enum(['read', 'write']),
  requiresConfirmation: z.boolean()
}).strict()

export const agentSoftwarePlanSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  goal: z.string().min(1).max(AGENT_MAX_GOAL_CHARS),
  steps: z.array(agentSoftwarePlanStepSchema).min(1).max(8),
  requiresConfirmation: z.boolean(),
  status: z.enum(AGENT_PLAN_STATUSES)
}).strict()

export const agentSoftwareExecuteInputSchema = z.object({
  plan: agentSoftwarePlanSchema,
  confirmed: z.boolean().default(false)
}).strict()

/** 模型原始返回格式：风险等级、确认标记与店铺/标签信息由 Main 派生。 */
export const agentPlanProposalSchema = z.object({
  name: z.string().min(1).max(80),
  steps: z.array(z.object({
    type: z.enum(AGENT_PROPOSAL_STEP_TYPES),
    input: z.record(z.unknown()).default({}),
    description: z.string().min(1).max(120),
    timeoutMs: z.number().int().min(500).max(AGENT_MAX_TIMEOUT_MS).optional(),
    retryLimit: z.number().int().min(0).max(1).optional()
  }).strict()).min(1).max(AGENT_MAX_PROPOSAL_STEPS),
  schedule: agentScheduleSchema.nullable().optional()
}).strict()

export const agentPlanStepSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(AGENT_STEP_TYPES),
  input: z.record(z.unknown()),
  description: z.string().min(1).max(120),
  risk: z.enum(AGENT_RISK_LEVELS),
  requiresConfirmation: z.boolean(),
  timeoutMs: z.number().int().min(500).max(3600000),
  retryLimit: z.number().int().min(0).max(1)
}).strict()

export const agentPlanSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  goal: z.string().min(1).max(AGENT_MAX_GOAL_CHARS),
  storeId: z.string().min(1).max(80),
  storeName: z.string().min(1).max(120),
  tabId: z.string().min(1).max(100),
  currentUrl: z.string().max(500),
  pageTitle: z.string().max(240),
  steps: z.array(agentPlanStepSchema).min(1).max(AGENT_MAX_PLAN_STEPS),
  schedule: agentScheduleSchema.nullable(),
  requiresConfirmation: z.boolean(),
  status: z.enum(AGENT_PLAN_STATUSES)
}).strict()

export const agentUiMessageSummarySchema = z.object({
  role: z.enum(['user', 'assistant']),
  summary: z.string().max(200),
  at: z.number().int().nonnegative()
}).strict()

export const agentUiStateSchema = z.object({
  orbPosition: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  }).strict(),
  drawerOpen: z.boolean(),
  messageSummaries: z.array(agentUiMessageSummarySchema).max(40)
}).strict()

/** 对话记忆：只带最近几轮的脱敏文本，供模型消除指代和延续上下文。 */
export const agentConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(1000)
}).strict()

export const agentPlanGenerateInputSchema = z.object({
  goal: z.string().trim().min(1).max(AGENT_MAX_GOAL_CHARS),
  history: z.array(agentConversationTurnSchema).max(12).default([])
}).strict()

export type AgentPlanStatus = (typeof AGENT_PLAN_STATUSES)[number]
export type AgentRisk = (typeof AGENT_RISK_LEVELS)[number]
export type AgentStepType = (typeof AGENT_STEP_TYPES)[number]
export type AgentProposalStepType = (typeof AGENT_PROPOSAL_STEP_TYPES)[number]
export type AgentPlanProposal = z.infer<typeof agentPlanProposalSchema>
export type AgentPlanStep = z.infer<typeof agentPlanStepSchema>
export type AgentPlan = z.infer<typeof agentPlanSchema>
export type AgentPageObservation = z.infer<typeof agentPageObservationSchema>
export type AgentUiState = z.infer<typeof agentUiStateSchema>
export type AgentSoftwareActionType = (typeof AGENT_SOFTWARE_ACTION_TYPES)[number]
export type AgentSoftwarePanel = (typeof AGENT_SOFTWARE_PANELS)[number]
export type AgentCreatableRole = (typeof AGENT_CREATABLE_ROLES)[number]
export type AgentSkill = z.infer<typeof agentSkillSchema>
export type AgentSkillStep = z.infer<typeof agentSkillStepSchema>
export type AgentPlugin = z.infer<typeof agentPluginSchema>
export type AgentPack = z.infer<typeof agentPackSchema>
export type AgentStoreSummary = z.infer<typeof agentStoreSummarySchema>
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>
export type AgentSoftwareContext = z.infer<typeof agentSoftwareContextSchema>
export type AgentSoftwareAction = z.infer<typeof agentSoftwareActionSchema>
export type AgentSoftwarePlanStep = z.infer<typeof agentSoftwarePlanStepSchema>
export type AgentSoftwarePlan = z.infer<typeof agentSoftwarePlanSchema>

export const DEFAULT_AGENT_UI_STATE: AgentUiState = {
  // Start near the lower edge, leaving room for the task workspace while
  // avoiding a forced corner. Dragging can dock the orb anywhere on any edge.
  orbPosition: { x: 0.84, y: 1 },
  drawerOpen: false,
  messageSummaries: []
}
