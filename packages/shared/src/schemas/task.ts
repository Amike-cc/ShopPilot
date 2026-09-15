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
  // 条件点击：文案为 text 的确认按钮**出现就点、没出现就跳过**（如实记录 clicked）。
  // 用途：平台是否弹二次确认框未定时，既不能硬等（白等超时、把成功报成失败），
  // 也不能假设没有（真弹了没人点，发送其实没发出去）。
  'clickIfPresent',
  // 按键（白名单：仅 Escape）：用途是**收起页面上残留的下拉浮层**——
  // 实测快手选完带货类目后级联下拉仍展开着，盖住了后面要点的按钮。
  // 只接受 Escape，不开放任意键，避免变成"通用键盘入口"。
  'pressKey',
  'setInput',
  // 调用主进程大模型按"读取到的商品信息"生成文本并写入目标（达人邀约话术）；
  // 属于副作用步骤：需 AI 已配置，未配置时如实报 AI_NOT_CONFIGURED，不静默跳过
  'aiGenerate',
  // ---------- 微信小店（assist-form 流程）专用，见 shared/constants/invite.ts ----------
  // 在店铺其他标签页里找 URL 含 urlIncludes 的页面（人工进到的邀约表单页），
  // 把运行标签页导航过去并激活——列表 DOM 拿不到 finderUsername，选人必须人工完成
  'mirrorTabUrl',
  // 受信任键鼠输入（点击聚焦 → Ctrl+A → Delete → insertText）：微信表单不吃合成 input 事件
  'typeText',
  // 轮询等待「可见元素的自有文本」包含 text（ShadowRoot 穿透可选）；
  // waitForSelector 只查元素存在，而微信弹窗节点常预渲染在 DOM 里，必须等"可见文本"
  'waitForText',
  // 确保页面可见行数 ≥ min：已有则不动；没有才点 addText 入口 → 弹窗勾选未选项（≤max）→
  // 点 confirmText → 复核。用于"邀约商品"（页面已有商品则不重复添加）
  'ensureRows',
  // 按商品ID数组在菜单中逐个搜索并勾选指定商品行（邀约商品用），确认后再复核
  'ensureRowsById',
  // 额度预检：在可见元素自有文本里找 textIncludes，提取其中数字，≥ min 才放行；
  // 不足如实报 TASK_QUOTA_EXCEEDED（微信小店「今日剩余N次邀请机会」）。optional=true 时
  // 平台不展示额度则放行（payload 如实记录 present:false）
  'requireQuota',
  // 可用性预检：找文案为 text 的可见按钮，若处于禁用态（额度用尽/平台限制）如实报
  // TASK_QUOTA_EXCEEDED——用于抖店抽屉「确认发送」（抖店不在页面展示剩余额度数字）
  'requireEnabled',
  // 文案缺席断言（读型）：页面上**不该出现**这段文案，出现了就按 code 如实失败。
  // 用途：提交类动作之后，平台会**用文案告诉我们它拒绝了**——实测快手点「发送邀请」后
  // 弹「部分邀约发送失败」（近7天有未处理/被拒绝的邀约单，暂不能发送），此时抽屉**会一直开着**
  // （平台设计如此，让你调整后重试），所以"抽屉没关"根本区分不出"发送失败"与"平台还没处理完"。
  // 必须读这段失败文案才能如实报出"这一批其实没发出去"，而不是靠点了按钮就当成发出去了。
  'requireTextAbsent',
  // 按标签文案读取指标值（数据中心用）：页面上的指标卡片类名普遍带构建哈希（实测快手
  // kpro-data、微信 weui 均如此），写死哈希选择器会随版本失效；而标签文案（如「成交金额」）
  // 是平台对外的稳定表达。本步骤以文案为锚：找到该标签元素后向上找"只多出这一小段文本"
  // 的最近祖先，取多出来的那段作为值；超过长度阈值就如实失败，绝不从整页噪音里猜数字。
  'readLabelValue',
  // 显式等待（读型步骤）：SPA 点了周期/筛选后要重新取数，数值原地刷新而不是新增元素，
  // 「等元素出现」类判据会立刻命中旧值（实测快手周期切换踩过）——只能显式等页面刷完。
  'waitMs',
  // 等元素消失/不可见（读型步骤）：提交类动作后的**结果校验**——例如点击"确认发送"后
  // 邀约抽屉应当关闭；抽屉还在就说明提交没被接受，如实失败而不是把"点了"当"发了"
  'waitForGone',
  // 批次循环（复合作步骤）：把一轮完整动作重复执行，直到命中 stopOn 里的错误码（干净停止，
  // 例如"邀约额度用完""可选达人不足"）或达到 maxRounds。嵌套步骤同样每个都走白名单校验。
  'loop',
  // 切到"已经打开的某个标签页"上继续（不导航、不重载）：微信邀约逐轮换人时必须回到
  // 那个**一直活着**的广场页——重载会重置分页与筛选，而平台的翻页是内部状态（URL 不变）。
  // 默认关闭当前运行标签页，避免详情/表单页越堆越多。
  'useTab'
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
