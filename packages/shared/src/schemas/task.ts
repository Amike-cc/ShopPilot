/**
 * 任务引擎类型 - §4.4 / §5.6 / §5.10 / §5.11 / §6.4 / §9.2
 * 步骤只允许预定义类型；不接受来自网页或渲染层的任意代码。
 */

export const TASK_STEP_TYPES = [
  'navigate',
  'waitForPage',
  'waitForSelector',
  'readText',
  'readTable',
  'screenshot',
  'fillDraft',
  'waitForUserConfirmation',
  // 以下四类会对页面产生副作用（点击/写入）：全部走固定注入脚本 + Zod 校验参数，
  // 仍不提供任何"执行任意代码"的入口；提交类动作必须在其前放置 waitForUserConfirmation 门禁。
  'click',
  'clickByText',
  'clickAll',
  'setInput',
  // 调用主进程大模型按"读取到的商品信息"生成文本并写入目标（达人邀约话术）；
  // 属于副作用步骤：需 AI 已配置，未配置时如实报 AI_NOT_CONFIGURED，不静默跳过
  'aiGenerate'
] as const

export type TaskStepType = (typeof TASK_STEP_TYPES)[number]

/** 步骤结构化结果类型 - §5.10 */
export const STEP_RESULT_KINDS = ['text', 'table', 'screenshot'] as const
export type StepResultKind = (typeof STEP_RESULT_KINDS)[number]

/** 进度事件阶段 */
export type TaskProgressPhase = 'queued' | 'started' | 'succeeded' | 'failed' | 'retry' | 'paused' | 'resumed' | 'finished'

export interface TaskStepDef {
  index: number
  type: TaskStepType
  input: Record<string, unknown>
  timeoutMs: number
  retryLimit: number
}

/** task:create 输入（Zod 校验在 Main 侧） */
export interface TaskCreateInput {
  name: string
  storeScope?: string | null
  steps: Array<{
    type: string
    input?: Record<string, unknown>
    timeoutMs?: number
    retryLimit?: number
  }>
  schedule?: { everyMs: number } | null
}

export interface TaskView {
  id: string
  name: string
  storeScope: string | null
  status: string
  schedule: { everyMs: number } | null
  lastFiredAt: number | null
  createdAt: number
  updatedAt: number
  steps: TaskStepDef[]
  latestRun: TaskRunView | null
}

export interface TaskRunView {
  id: string
  taskId: string
  storeId: string
  status: string
  currentStep: number | null
  startedAt: number | null
  finishedAt: number | null
  errorCode: string | null
  errorMessage: string | null
  statusReason: string | null
}

export interface TaskStepResultView {
  id: string
  runId: string
  stepIndex: number
  /** executed = 等待/导航类步骤的成功凭据（恢复时据此跳过已完成步骤） */
  kind: StepResultKind | 'confirm' | 'executed'
  summary: string
  payload: unknown
  artifactPath: string | null
  artifactSha256: string | null
  createdAt: number
}

export interface TaskResults {
  run: TaskRunView
  steps: TaskStepDef[]
  results: TaskStepResultView[]
}

export interface TaskProgressEvent {
  runId: string
  taskId: string
  storeId: string
  status: string
  phase: TaskProgressPhase
  stepIndex?: number
  stepType?: TaskStepType
  message?: string
}

export interface TaskConfirmationEvent {
  runId: string
  taskId: string
  storeId: string
  stepIndex: number
  message: string
}

export interface TaskScheduledFiredEvent {
  runId: string
  taskId: string
  storeId: string
  /** §4.4：计划触发时店铺浏览器未运行 → 保持 queued 并提示，不静默拉起 */
  queuedWaiting: boolean
  message: string
}
