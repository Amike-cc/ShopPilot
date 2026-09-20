/**
 * 自定义任务的步骤目录与创建前校验
 *
 * 【为什么需要这一层】
 * 「新建任务」此前**刻意只从已实测跑通的流程里挑**，不给底层步骤编辑器，理由是：
 * 引擎步骤类型有 20 多种，让用户自己拼 navigate/readTable/click… 必然拼出跑不通的半成品
 * （选择器写不对、少了必要的等待、提交类动作漏了确认门禁），而失败会以"任务失败"回抛，
 * 用户无从对应到"我少填了哪个字段"（见 WorkbenchView.vue 新建任务对话框的注释）。
 *
 * 现在要开这个口子，就必须把那条理由**逐条堵上**，否则等于明知故犯地造一个产出坏任务的功能：
 *   ① "选择器写不对、字段拼错" → 不再让用户裸写 JSON，而是**按目录渲染表单**：
 *      每种步骤只暴露它真正接受的字段，字段名来自本目录（与主进程 Zod schema 一一对应，
 *      有单测钉住不许漂移），用户拼不出 schema 之外的键；
 *   ② "少了必要的等待" → 目录把步骤按用途分组（导航/等待/读取/交互/断言/门禁），
 *      并在校验里对"开局没有导航"这类常见疏漏给警告；
 *   ③ "提交类动作漏了确认门禁" → 这是最危险的一条：编排器要求用户**显式标记**哪些步骤是
 *      提交/不可逆动作，校验时强制它前面必须有一道 waitForUserConfirmation 门禁，
 *      缺失就**拒绝创建**并说明原因。
 *
 * 【为什么权威校验仍在主进程】
 * 本模块的校验是"创建前的即时反馈"，让用户在点按钮之前就知道哪里不对。
 * 真正的权威仍是主进程的 Zod（task-store.validateStepInput）：它不可能被渲染层绕过，
 * 且是唯一会写库的那道关。两者字段一致由单测保证（见 tests/unit/custom-task.test.ts）。
 */

import type { TaskStepType } from './schemas/task'

/** 表单字段类型：决定编排器渲染什么控件 */
export type StepFieldKind = 'text' | 'number' | 'boolean' | 'select' | 'within'

export interface StepFieldDef {
  /** 对应 Zod schema 里的键名（必须完全一致，strict() 下多一个键都会被拒） */
  key: string
  label: string
  kind: StepFieldKind
  required?: boolean
  placeholder?: string
  hint?: string
  /** kind='select' 的可选项 */
  options?: Array<{ value: string; label: string }>
  /** kind='number' 的范围，与 Zod 的 min/max 对齐（不一致会导致创建时被主进程拒） */
  min?: number
  max?: number
  /**
   * 文本长度上限，与 Zod 的 max 对齐。
   * 不加这条就会出现"表单填得下、创建被拒"——主进程 strict() 校验里每个字符串都有 max，
   * 而浏览器里的输入框没有长度上限（实测：600 字符的选择器能填进去，创建时报
   * TASK_INVALID_STEP: selector too_big）。
   */
  maxLength?: number
  /** 值的格式约束，与 Zod 对齐。'httpUrl' = 必须是合法的 http/https 网址。 */
  format?: 'httpUrl'
  /** 新建该步骤时的初始值 */
  default?: string | number | boolean
}

export interface StepCatalogEntry {
  type: TaskStepType
  /** 中文标签（编排器里显示这个，不显示英文 type） */
  label: string
  /** 分组：编排器按组给"添加步骤"分类，也让用户看得出步骤的用途 */
  group: string
  /** 一句话说明这步做什么、什么场景用 */
  desc: string
  /** 会对页面产生副作用（点击/写入/提交）→ 参与"提交门禁"与"禁止重试"校验 */
  sideEffect: boolean
  /** 可安全重放（重跑一次不会造成额外副作用）→ 只有这类才允许设 retryLimit */
  idempotent: boolean
  fields: StepFieldDef[]
  /**
   * 互斥必填组：每个子数组里**恰好填一个**（对应 Zod 的 `.refine(!!a !== !!b)`）。
   * 例：clickAll 的 selector / text 二选一。
   */
  requiredOneOf?: string[][]
}

/** 编排器里的一条草稿步骤（input 之外的字段是编排器自己的元数据，不发给引擎） */
export interface CustomStepDraft {
  type: string
  input: Record<string, unknown>
  /**
   * 是否"提交/不可逆动作"（用户显式标记）。
   *
   * 为什么要用户标而不是按步骤类型自动判定：同一个 clickByText，点「搜索」和点「确认发送」
   * 的危险程度天差地别，而步骤类型看不出区别。让用户标 = 把判断放在知道业务的人手里，
   * 但一旦标了，校验就**强制**它前面必须有确认门禁——判断归用户，约束归系统。
   */
  submit?: boolean
  retryLimit?: number
  timeoutMs?: number
}

/**
 * 整单步骤数上限，必须与主进程 taskCreateSchema 的 `.max(30)` 对齐。
 * 不对齐的话第 31 步之前一切正常，点创建才会被 Zod 拒（用户看不到任何线索）。
 */
export const CUSTOM_TASK_MAX_STEPS = 30

/** within 子字段的上限，与 Zod 的 within schema 对齐 */
const WITHIN_LIMITS = { selector: 300, text: 60, climbMin: 0, climbMax: 6 } as const

/** 创建前校验的一条问题 */
export interface CustomStepIssue {
  level: 'error' | 'warning'
  /** 出问题的步骤下标（整单级问题为 undefined） */
  stepIndex?: number
  message: string
}

/**
 * 步骤目录：编排器可用的步骤集合。
 *
 * 【收录口径】只收**能独立表达、不依赖具体业务流程上下文**的步骤。
 * 刻意不收的几类（不是漏了，是不该给）：
 *   - loop / onCode：嵌套编排需要另一套递归 UI，且它承载的是"批量发送"这类高风险流程，
 *     实测跑通的档案已经把它们包好了，让用户手工拼循环只会拼错；
 *   - ensureRows / ensureRowsById / aiGenerate / fillDraft / mirrorTabUrl：
 *     平台流程专用（邀约商品弹窗、微信表单镜像），脱离该流程没有意义。
 * 这些仍由各自的业务面板按已实测档案创建，不走自定义编排。
 */
export const STEP_CATALOG: StepCatalogEntry[] = [
  // ---------- 导航 ----------
  {
    type: 'navigate',
    label: '打开网址',
    group: '导航',
    desc: '导航到指定地址。自定义任务通常以它开头。',
    sideEffect: false,
    idempotent: true,
    fields: [
      {
        key: 'url', label: '网址', kind: 'text', required: true,
        placeholder: 'https://…（仅 http/https）', format: 'httpUrl'
      }
    ]
  },
  {
    type: 'useTab',
    label: '切到已打开的标签页',
    group: '导航',
    desc: '切到本次运行里已经打开的某个标签页（不重新加载，保留页面内部状态）。',
    sideEffect: false,
    // 切标签页会改写运行态（tabId），重放没有意义 —— 与引擎的 NON_RESUMABLE_TYPES 一致
    idempotent: false,
    fields: [
      { key: 'path', label: '按路径精确匹配', kind: 'text', maxLength: 300, placeholder: '/shop/xxx' },
      { key: 'urlIncludes', label: '按地址包含匹配', kind: 'text', maxLength: 300, placeholder: 'finder-square' },
      { key: 'closeCurrent', label: '切换前关掉当前标签页', kind: 'boolean', default: true }
    ],
    requiredOneOf: [['path', 'urlIncludes']]
  },

  // ---------- 等待 ----------
  {
    type: 'waitForPage',
    label: '等页面地址就绪',
    group: '等待',
    desc: '轮询当前地址包含指定片段。留空则只等加载完成。',
    sideEffect: false,
    idempotent: true,
    fields: [{ key: 'urlIncludes', label: '地址包含', kind: 'text', maxLength: 300, placeholder: '例如 /qualification/home' }]
  },
  {
    type: 'waitForSelector',
    label: '等元素出现',
    group: '等待',
    desc: '等选择器匹配的元素出现在页面上。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500, placeholder: 'tbody input[type=checkbox]' },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' }
    ]
  },
  {
    type: 'waitForText',
    label: '等文案出现',
    group: '等待',
    desc: '等页面上出现这段可见文案。比等元素更稳（平台节点常预渲染在 DOM 里）。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'text', label: '文案', kind: 'text', required: true, maxLength: 200, placeholder: '例如 邀请带货' },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'within', label: '限定查找范围', kind: 'within' }
    ]
  },
  {
    type: 'waitMs',
    label: '固定等待',
    group: '等待',
    desc: '显式等待若干毫秒。SPA 原地刷新数据时用它（"等元素出现"会立刻命中旧值）。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'ms', label: '毫秒', kind: 'number', required: true, min: 100, max: 120000, default: 3000 }
    ]
  },
  {
    type: 'waitForGone',
    label: '等元素消失',
    group: '等待',
    desc: '等元素消失/不可见。用于提交后的结果校验（例如抽屉应当关闭）。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' }
    ]
  },

  // ---------- 读取 ----------
  {
    type: 'readText',
    label: '读取文本',
    group: '读取',
    desc: '读选择器匹配元素的文本，落成一次快照。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500 },
      { key: 'metric', label: '指标名', kind: 'text', maxLength: 60, placeholder: '落库用的键名，如 invite.quota' },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' }
    ]
  },
  {
    type: 'readLabelValue',
    label: '按标签读值',
    group: '读取',
    desc: '按页面标签文案读它旁边的值。平台类名普遍带构建哈希，按文案读才扛得住改版。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'label', label: '标签文案', kind: 'text', required: true, maxLength: 60, placeholder: '例如 成交金额' },
      { key: 'metric', label: '指标名', kind: 'text', maxLength: 60 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'allowText', label: '允许取非数字文本', kind: 'boolean' },
      { key: 'absentOk', label: '页面上没有这一行也算通过', kind: 'boolean' }
    ]
  },
  {
    type: 'readTable',
    label: '读取表格',
    group: '读取',
    desc: '读整张表（按行落快照）。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'selector', label: '表格选择器', kind: 'text', required: true, maxLength: 500, placeholder: 'table' },
      { key: 'metric', label: '指标名', kind: 'text', maxLength: 60 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'keepRows', label: '保留整表行内容', kind: 'boolean' },
      { key: 'emptyOk', label: '表本来就可能没有（空表不算失败）', kind: 'boolean' }
    ]
  },
  {
    type: 'screenshot',
    label: '截图留档',
    group: '读取',
    desc: '对当前页面截图并作为步骤产物留档。',
    sideEffect: false,
    idempotent: true,
    fields: []
  },

  // ---------- 交互（有副作用） ----------
  {
    type: 'click',
    label: '点击元素',
    group: '交互',
    desc: '按选择器点击。',
    sideEffect: true,
    idempotent: false,
    fields: [{ key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500 }]
  },
  {
    type: 'clickByText',
    label: '按文案点击',
    group: '交互',
    desc: '点文案匹配的元素。平台改版后文案比类名活得久，优先用它。',
    sideEffect: true,
    idempotent: false,
    fields: [
      { key: 'text', label: '文案', kind: 'text', required: true, maxLength: 200 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      {
        key: 'mode', label: '点击方式', kind: 'select', default: 'js',
        options: [
          { value: 'js', label: 'JS 点击（默认，不受遮挡影响）' },
          { value: 'real', label: '真实鼠标（框架对合成点击不响应时用）' }
        ]
      },
      { key: 'within', label: '限定查找范围', kind: 'within' }
    ]
  },
  {
    type: 'clickIfPresent',
    label: '有就点、没有就跳过',
    group: '交互',
    desc: '目标出现就点、没出现就跳过（不算失败）。用于平台"可能会弹"的二次确认框。',
    sideEffect: true,
    idempotent: false,
    fields: [
      { key: 'text', label: '文案', kind: 'text', required: true, maxLength: 200 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'waitMs', label: '等待毫秒', kind: 'number', min: 500, max: 60000, default: 8000 },
      { key: 'nearText', label: '限定在含此文案的弹层内', kind: 'text', maxLength: 200, placeholder: '用于区分同名按钮' }
    ]
  },
  {
    type: 'clickAll',
    label: '批量勾选',
    group: '交互',
    desc: '按选择器或文案批量勾选，最多 max 个（可滚动续选）。',
    sideEffect: true,
    idempotent: false,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', maxLength: 500, placeholder: 'tbody input[type=checkbox]' },
      { key: 'text', label: '文案', kind: 'text', maxLength: 200, placeholder: '与选择器二选一' },
      { key: 'max', label: '最多勾选', kind: 'number', required: true, min: 1, max: 40, default: 1 },
      { key: 'scroll', label: '滚动续选（虚拟滚动列表）', kind: 'boolean' },
      { key: 'maxRounds', label: '滚动最多轮数', kind: 'number', min: 1, max: 60 },
      { key: 'counterIncludes', label: '计数文案必须包含', kind: 'text', maxLength: 40, placeholder: '用于区分页面上的多个"已选N"' }
    ],
    requiredOneOf: [['selector', 'text']]
  },
  {
    type: 'setInput',
    label: '填写输入框',
    group: '交互',
    desc: '写入输入框（合成 input 事件）。对不吃合成事件的表单改用"键盘输入"。',
    sideEffect: true,
    idempotent: true,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500 },
      { key: 'text', label: '内容', kind: 'text', required: true, maxLength: 2000 }
    ]
  },
  {
    type: 'typeText',
    label: '键盘输入',
    group: '交互',
    desc: '受信任键鼠输入（聚焦 → 全选 → 删除 → 输入）。表单不吃合成事件时用它。',
    sideEffect: true,
    idempotent: true,
    fields: [
      { key: 'selector', label: '选择器', kind: 'text', required: true, maxLength: 500 },
      { key: 'text', label: '内容', kind: 'text', required: true, maxLength: 2000 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' }
    ]
  },
  {
    type: 'pressKey',
    label: '按键',
    group: '交互',
    desc: '只开放 Escape：用于收起页面上残留的下拉浮层。',
    sideEffect: true,
    idempotent: false,
    fields: [
      {
        key: 'key', label: '按键', kind: 'select', required: true, default: 'Escape',
        options: [{ value: 'Escape', label: 'Escape（收起浮层）' }]
      }
    ]
  },

  // ---------- 断言（读型，无副作用） ----------
  {
    type: 'requireQuota',
    label: '断言数字 ≥ 下限',
    group: '断言',
    desc: '页面文案里的数字必须 ≥ 下限，否则如实失败。用于额度预检等。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'textIncludes', label: '文案包含', kind: 'text', required: true, maxLength: 100, placeholder: '例如 今日剩余' },
      { key: 'min', label: '下限', kind: 'number', required: true, min: 0, max: 100000, default: 1 },
      { key: 'optional', label: '页面上没有这段文案则放行', kind: 'boolean' },
      { key: 'hint', label: '失败时的提示', kind: 'text', maxLength: 200 }
    ]
  },
  {
    type: 'requireEnabled',
    label: '断言按钮可用',
    group: '断言',
    desc: '文案匹配的按钮不能是禁用态，禁用则如实失败。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'text', label: '按钮文案', kind: 'text', required: true, maxLength: 200 },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'hint', label: '失败时的提示', kind: 'text', maxLength: 200 }
    ]
  },
  {
    type: 'requireTextAbsent',
    label: '断言文案不出现',
    group: '断言',
    desc: '页面上不该出现这段文案；出现即如实失败。用于识别平台用文案告知的拒绝。',
    sideEffect: false,
    idempotent: true,
    fields: [
      { key: 'text', label: '文案', kind: 'text', required: true, maxLength: 200, placeholder: '例如 部分邀约发送失败' },
      { key: 'deep', label: '穿透 ShadowRoot', kind: 'boolean' },
      { key: 'hint', label: '失败时的提示', kind: 'text', maxLength: 300 },
      { key: 'waitMs', label: '命中前最长轮询毫秒', kind: 'number', min: 0, max: 60000 }
    ]
  },

  // ---------- 门禁 ----------
  {
    type: 'waitForUserConfirmation',
    label: '人工确认门禁',
    group: '门禁',
    desc: '暂停并等用户确认后才继续。**提交/不可逆动作之前必须放一道**。',
    sideEffect: false,
    idempotent: false,
    fields: [
      { key: 'message', label: '确认提示语', kind: 'text', required: true, maxLength: 500, placeholder: '确认向 40 位达人发送邀约？' }
    ]
  }
]

/** 按 type 取目录项 */
export function findCatalogEntry(type: string): StepCatalogEntry | undefined {
  return STEP_CATALOG.find(e => e.type === type)
}

/** 目录分组（保持目录里的出现顺序，编排器的"添加步骤"按它分类） */
export function catalogGroups(): string[] {
  const out: string[] = []
  for (const e of STEP_CATALOG) if (!out.includes(e.group)) out.push(e.group)
  return out
}

/** 是否副作用步骤（以目录为准；目录里没有的类型按"有副作用"处理，宁可严一点） */
export function isSideEffectStep(type: string): boolean {
  const e = findCatalogEntry(type)
  return e ? e.sideEffect : true
}

/** 新建一条草稿步骤（带上目录里声明的默认值） */
export function makeDraftStep(type: string): CustomStepDraft {
  const entry = findCatalogEntry(type)
  const input: Record<string, unknown> = {}
  for (const f of entry?.fields || []) {
    if (f.default !== undefined && f.kind !== 'within') input[f.key] = f.default
  }
  return { type, input, ...(entry?.sideEffect ? { submit: false } : {}) }
}

/**
 * 是否是合法的 http/https 网址（与主进程 Zod 的 `url().refine(仅 http/https)` 同义）。
 * 用 WHATWG URL 解析而不是正则：`ftp://`、`javascript:`、`http://`（无主机）都要判否，
 * 而这些正是用户手填地址时最容易写出来的。
 */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 创建前校验。
 *
 * 只报"确定有问题"的为 error（拦住创建），其余为 warning（提示但不拦）。
 * 判据都来自主进程 schema 或本仓库已确立的规矩，不做主观发挥：
 *   - 字段必填 / 数值范围 / 文本长度 / 网址格式 / 互斥组 / 步骤总数：与 Zod 对齐，
 *     早报比创建时被拒好。**这几项必须是子集关系**：客户端放行的，主进程必须也放行，
 *     否则用户看到的就是"表单说能用、点创建报 TASK_INVALID_STEP"；
 *   - 提交类动作前必须有门禁：这是本仓库对写型步骤的既定红线；
 *   - 副作用步骤不许设重试：重试 = 重复点击/重复提交（引擎 NON_RESUMABLE_TYPES 的同一道理）。
 */
export function validateCustomSteps(steps: CustomStepDraft[]): CustomStepIssue[] {
  const issues: CustomStepIssue[] = []

  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({ level: 'error', message: '至少要有一个步骤' })
    return issues
  }

  // 总数上限与主进程 taskCreateSchema 对齐，早报在创建之前
  if (steps.length > CUSTOM_TASK_MAX_STEPS) {
    issues.push({
      level: 'error',
      message: `步骤最多 ${CUSTOM_TASK_MAX_STEPS} 步（当前 ${steps.length} 步），请拆分或合并`
    })
  }

  let sawGate = false
  let sawSubmit = false
  let sawNavigation = false

  steps.forEach((s, i) => {
    const where = `第 ${i + 1} 步`
    const entry = findCatalogEntry(s.type)

    if (!entry) {
      issues.push({ level: 'error', stepIndex: i, message: `${where}：未登记的步骤类型「${s.type}」` })
      return
    }

    if (entry.type === 'waitForUserConfirmation') sawGate = true
    if (entry.type === 'navigate' || entry.type === 'useTab') sawNavigation = true

    // 必填字段与数值范围（与 Zod 对齐，早报早改）
    for (const f of entry.fields) {
      const v = s.input?.[f.key]
      const empty = v === undefined || v === null || v === ''
      if (f.required && empty) {
        issues.push({ level: 'error', stepIndex: i, message: `${where}「${entry.label}」：${f.label}不能为空` })
        continue
      }
      if (empty) continue
      if (f.kind === 'number') {
        const n = Number(v)
        if (!Number.isFinite(n)) {
          issues.push({ level: 'error', stepIndex: i, message: `${where}「${entry.label}」：${f.label}必须是数字` })
        } else if (!Number.isInteger(n)) {
          // 主进程所有数值字段都是 .int()，小数会被拒（实测："3.5 秒"这种输入直接 TASK_INVALID_STEP）
          issues.push({ level: 'error', stepIndex: i, message: `${where}「${entry.label}」：${f.label}必须是整数` })
        } else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          const range = [f.min !== undefined ? `最小 ${f.min}` : '', f.max !== undefined ? `最大 ${f.max}` : '']
            .filter(Boolean).join('、')
          issues.push({ level: 'error', stepIndex: i, message: `${where}「${entry.label}」：${f.label}超出范围（${range}）` })
        }
      }
      // 文本长度上限：主进程 strict() 里每个字符串都有 max，表单没有上限就会
      // "填得进去、创建被拒"（实测 600 字符选择器 → TASK_INVALID_STEP: too_big）
      if (f.kind === 'text' && f.maxLength !== undefined && String(v).length > f.maxLength) {
        issues.push({
          level: 'error', stepIndex: i,
          message: `${where}「${entry.label}」：${f.label}最多 ${f.maxLength} 个字（当前 ${String(v).length} 个）`
        })
      }
      // 格式校验：与 Zod 的 httpUrl（url() + 仅 http/https）对齐
      if (f.kind === 'text' && f.format === 'httpUrl' && !isHttpUrl(String(v))) {
        issues.push({
          level: 'error', stepIndex: i,
          message: `${where}「${entry.label}」：${f.label}必须是完整网址（以 http:// 或 https:// 开头）`
        })
      }
      if (f.kind === 'within' && typeof v === 'object') {
        const w = v as Record<string, unknown>
        const hasSel = !!w.selector
        const hasText = !!w.text
        if (hasSel === hasText) {
          issues.push({
            level: 'error', stepIndex: i,
            message: `${where}「${entry.label}」：限定范围的选择器与文案必须二选一`
          })
        }
        if (hasSel && String(w.selector).length > WITHIN_LIMITS.selector) {
          issues.push({
            level: 'error', stepIndex: i,
            message: `${where}「${entry.label}」：限定范围的选择器最多 ${WITHIN_LIMITS.selector} 个字`
          })
        }
        if (hasText && String(w.text).length > WITHIN_LIMITS.text) {
          issues.push({
            level: 'error', stepIndex: i,
            message: `${where}「${entry.label}」：限定范围的文案最多 ${WITHIN_LIMITS.text} 个字`
          })
        }
        if (w.climb !== undefined && w.climb !== '') {
          const c = Number(w.climb)
          if (!Number.isFinite(c) || !Number.isInteger(c) || c < WITHIN_LIMITS.climbMin || c > WITHIN_LIMITS.climbMax) {
            issues.push({
              level: 'error', stepIndex: i,
              message: `${where}「${entry.label}」：上溯层数必须是 ${WITHIN_LIMITS.climbMin}~${WITHIN_LIMITS.climbMax} 的整数`
            })
          }
        }
      }
    }

    // 互斥必填组
    for (const group of entry.requiredOneOf || []) {
      const filled = group.filter(k => {
        const v = s.input?.[k]
        return v !== undefined && v !== null && v !== ''
      })
      if (filled.length !== 1) {
        const labels = group.map(k => entry.fields.find(f => f.key === k)?.label || k).join(' / ')
        issues.push({
          level: 'error', stepIndex: i,
          message: `${where}「${entry.label}」：${labels} 必须填且只能填一个`
        })
      }
    }

    // 提交类动作必须有前置门禁（本仓库对写型步骤的既定红线）
    if (s.submit) {
      sawSubmit = true
      if (!sawGate) {
        issues.push({
          level: 'error', stepIndex: i,
          message: `${where}「${entry.label}」标了"提交动作"，但它前面没有人工确认门禁——` +
            `请在它之前加一道「人工确认门禁」，否则任务会在无人值守时直接发出不可撤销的操作`
        })
      }
    }

    // 副作用步骤不许设重试（重试 = 重复点击/重复提交）
    if (s.retryLimit && s.retryLimit > 0 && !entry.idempotent) {
      issues.push({
        level: 'error', stepIndex: i,
        message: `${where}「${entry.label}」不能设重试：它不是可安全重放的动作，` +
          `重试会造成重复点击/重复提交`
      })
    }

    // 有副作用但没标"提交动作"：不是错，但值得提醒（用户可能忘了标）
    if (entry.sideEffect && !s.submit) {
      issues.push({
        level: 'warning', stepIndex: i,
        message: `${where}「${entry.label}」会改变页面状态。若这一步是"发出后不可撤销"的提交动作，` +
          `请勾上"提交动作"以便系统要求前置确认门禁`
      })
    }
  })

  if (!sawNavigation) {
    issues.push({
      level: 'warning',
      message: '整单没有"打开网址"或"切到已打开的标签页"：任务会从店铺当前停留的页面开始跑，' +
        '结果取决于当时停在哪一页。建议第一步先明确导航。'
    })
  }

  if (!sawSubmit && steps.some(s => isSideEffectStep(s.type))) {
    issues.push({
      level: 'warning',
      message: '包含会改变页面状态的步骤，但没有任何一步标记为"提交动作"。' +
        '若其中有不可撤销的操作，请标记它，系统会要求它前面有确认门禁。'
    })
  }

  return issues
}

/** 校验里是否存在阻断创建的错误 */
export function hasBlockingIssues(issues: CustomStepIssue[]): boolean {
  return issues.some(i => i.level === 'error')
}

/**
 * 把草稿整理成提交给主进程的步骤数组。
 *
 * 只保留目录声明的字段，并丢掉空值——`strict()` 下多一个键就会整单被拒，
 * 而表单里"没填"的字段很容易留下 undefined/空串。保留 `false` 与 `0`
 * （它们是合法取值，不是"没填"）。
 */
export function toEngineSteps(steps: CustomStepDraft[]): Array<Record<string, unknown>> {
  return steps.map(s => {
    const entry = findCatalogEntry(s.type)
    const input: Record<string, unknown> = {}
    for (const f of entry?.fields || []) {
      const v = s.input?.[f.key]
      if (v === undefined || v === null || v === '') continue
      if (f.kind === 'within') {
        const w = v as Record<string, unknown>
        const cleaned: Record<string, unknown> = {}
        if (w.selector) cleaned.selector = w.selector
        if (w.text) {
          cleaned.text = w.text
          if (w.climb !== undefined && w.climb !== '') cleaned.climb = Number(w.climb)
        }
        if (Object.keys(cleaned).length) input[f.key] = cleaned
        continue
      }
      input[f.key] = f.kind === 'number' ? Number(v) : v
    }
    const out: Record<string, unknown> = { type: s.type, input }
    if (s.timeoutMs !== undefined) out.timeoutMs = s.timeoutMs
    if (s.retryLimit !== undefined) out.retryLimit = s.retryLimit
    return out
  })
}
