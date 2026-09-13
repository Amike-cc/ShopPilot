/**
 * 任务步骤输入的白名单 Zod schema（§5.6）
 * 独立成文件：只依赖 zod 与 shared 常量，可被单测直接导入
 * （task-store.ts 依赖 SQLite/Electron，无法在 vitest 下加载）。
 * 步骤只允许预定义类型；输入 JSON 一律 Zod 校验（§5.6）。
 */

import { z } from 'zod'
import { TASK_STEP_TYPES } from '@shared/schemas/task'

const selector = z.string().min(1).max(500)
const httpUrl = z.string().url().refine(
  (u) => /^https?:\/\//i.test(u),
  { message: '仅允许 http/https 导航目标' }
)

export const stepInputSchemas: Record<string, z.ZodSchema> = {
  navigate: z.object({ url: httpUrl }).strict(),
  waitForPage: z.object({ urlIncludes: z.string().max(300).optional() }).strict(),
  // deep = 穿透 ShadowRoot 查询（微信小店整页在 micro-app 的 ShadowRoot 里）
  waitForSelector: z.object({ selector, deep: z.boolean().optional() }).strict(),
  readText: z.object({ selector, metric: z.string().min(1).max(60).optional(), deep: z.boolean().optional() }).strict(),
  readTable: z.object({ selector, metric: z.string().min(1).max(60).optional(), deep: z.boolean().optional() }).strict(),
  screenshot: z.object({}).strict(),
  fillDraft: z.object({ selector, text: z.string().max(20000) }).strict(),
  waitForUserConfirmation: z.object({ message: z.string().min(1).max(500) }).strict(),
  // 副作用步骤（点击/写入）：参数仍然只有选择器与文本，无任何代码入口
  click: z.object({ selector }).strict(),
  // mode:'real' = 受信任鼠标点击（定位元素中心 → 滚动可见 → sendInputEvent），
  // 用于框架对合成 click 不响应的目标；deep 同上穿透 ShadowRoot
  clickByText: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    mode: z.enum(['js', 'real']).optional()
  }).strict(),
  clickAll: z.object({
    selector: selector.optional(),
    text: z.string().min(1).max(200).optional(),
    // 平台对单次批量操作有上限（达人选人上限 40），这里做硬约束
    max: z.number().int().min(1).max(40),
    // scroll=true：点完当前可点的行后向下滚动列表继续选（虚拟滚动/滚动加载的列表，如抖店广场）
    scroll: z.boolean().optional(),
    // 滚动续选的最大轮数（防止无进展时空转）
    maxRounds: z.number().int().min(1).max(60).optional()
  }).strict().refine((v) => !!v.selector !== !!v.text, { message: 'selector 与 text 必须二选一' }),
  setInput: z.object({ selector, text: z.string().max(2000) }).strict(),
  // AI 生成：从 sourceSelector 读商品信息 → 主进程调大模型 → 写入 selector（参数仍只有选择器与文本/数值）
  // sourceSelector 允许留空 = 运行时改用「写入目标最近的固定定位浮层」（邀约抽屉）当来源，找不到就如实失败；
  // deep 时写入走 typeText 同款受信任输入（微信表单不吃合成 input 事件）
  aiGenerate: z.object({
    selector,
    sourceSelector: z.string().max(500),
    maxLen: z.number().int().min(20).max(300),
    instruction: z.string().max(300).optional(),
    deep: z.boolean().optional()
  }).strict(),
  // ---------- 微信小店（assist-form）----------
  mirrorTabUrl: z.object({ urlIncludes: z.string().min(1).max(300) }).strict(),
  typeText: z.object({ selector, text: z.string().max(2000), deep: z.boolean().optional() }).strict(),
  waitForText: z.object({ text: z.string().min(1).max(200), deep: z.boolean().optional() }).strict(),
  ensureRows: z.object({
    rowsSelector: selector,
    checkboxSelector: selector,
    addText: z.string().min(1).max(100),
    confirmText: z.string().min(1).max(100),
    min: z.number().int().min(0).max(100).optional(),
    max: z.number().int().min(1).max(100),
    deep: z.boolean().optional()
  }).strict(),
  // 额度预检（读型步骤，无副作用）：文本含 textIncludes 的可见元素里提取数字 ≥ min
  requireQuota: z.object({
    textIncludes: z.string().min(1).max(100),
    min: z.number().int().min(0).max(100000),
    optional: z.boolean().optional(),
    metric: z.string().min(1).max(60).optional(),
    deep: z.boolean().optional()
  }).strict(),
  // 可用性预检（读型步骤）：文案为 text 的可见按钮若禁用则如实失败
  requireEnabled: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    hint: z.string().max(200).optional()
  }).strict(),
  // 按标签文案读指标值（读型步骤）：标签 → 最近"多出一小段文本"的祖先 → 那段文本即值
  readLabelValue: z.object({
    label: z.string().min(1).max(60),
    metric: z.string().min(1).max(60).optional(),
    deep: z.boolean().optional(),
    /** 值的最大长度（超过视为爬到了容器层级，如实失败而不是取噪音），默认 40 */
    maxValueLen: z.number().int().min(1).max(200).optional()
  }).strict(),
  // 显式等待（读型步骤，上限 2 分钟）：等 SPA 按新筛选条件刷新数据
  waitMs: z.object({ ms: z.number().int().min(100).max(120000) }).strict(),
  // 等元素消失/不可见（读型步骤）：提交后校验结果（如邀约抽屉应关闭）
  waitForGone: z.object({ selector, deep: z.boolean().optional() }).strict()
}

/** 副作用步骤不可进入"从失败恢复"的重试范围 - §9.2（重试会重复点击/重复写入） */
export const NON_RESUMABLE_TYPES: ReadonlySet<string> = new Set([
  'fillDraft', 'waitForUserConfirmation',
  'click', 'clickByText', 'clickAll', 'setInput', 'aiGenerate',
  // 微信小店流程的副作用步骤同样不可重复执行（重复点击=重复发送风险）
  'typeText', 'ensureRows'
])

/** 非"确认门禁"类步骤的默认超时；批量点击要等框架重渲染、AI 生成要等模型返回，给更长默认值 */
export const DEFAULT_STEP_TIMEOUT: Record<string, number> = {
  waitForUserConfirmation: 3600000,
  clickAll: 120000,
  aiGenerate: 90000,
  mirrorTabUrl: 45000,
  typeText: 30000,
  waitForText: 30000,
  ensureRows: 120000,
  requireQuota: 30000,
  requireEnabled: 20000,
  readLabelValue: 25000,
  waitMs: 120000,
  waitForGone: 30000
}

export const taskCreateSchema = z.object({
  name: z.string().min(1).max(80),
  storeScope: z.string().max(80).nullish(),
  steps: z.array(z.object({
    type: z.enum(TASK_STEP_TYPES as unknown as [string, ...string[]]),
    input: z.record(z.unknown()).optional(),
    // 上限必须覆盖人工确认门禁的默认超时（1 小时）：曾写死 10 分钟，导致"达人邀约"这类
    // 把门禁 timeoutMs 设成 30 分钟的任务在创建阶段就被拒（实测报 steps[N].timeoutMs too_big）
    timeoutMs: z.number().int().min(500).max(3600000).optional(),
    retryLimit: z.number().int().min(0).max(5).optional()
  })).min(1).max(30),
  schedule: z.object({ everyMs: z.number().int().min(60000).max(30 * 86400000) }).nullish()
})
