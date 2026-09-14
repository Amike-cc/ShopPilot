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

/**
 * 查找范围限定（把点击/等待限定在页面某一块里）。
 * 实测动机（抖店广场）：类目名在筛选 chip 和达人卡片的类目文案里都会出现，
 * 且"不限"在等级下拉里也有同名项——不限定范围就会点错目标、筛选静默失效。
 *   - selector：CSS 限定（如级联弹层 .quick-filter-cascader-popover）；
 *   - text (+climb)：按"自身文本等于该文案"的元素定位，再向上爬 climb 层当范围
 *     （如「已筛选」标签行：标签自身不含类目名，得爬到它父容器）。
 */
const within = z.object({
  selector: z.string().min(1).max(300).optional(),
  text: z.string().min(1).max(60).optional(),
  climb: z.number().int().min(0).max(6).optional()
}).strict().refine((v) => !!v.selector !== !!v.text, { message: 'within.selector 与 within.text 必须二选一' })

/** 单步（可被 loop 嵌套，故用 lazy 自引用）；strict：多写一个字段都算错，别让拼错的键静默失效 */
export const taskStepSchema: z.ZodType<any> = z.lazy(() => z.object({
  type: z.enum(TASK_STEP_TYPES as unknown as [string, ...string[]]),
  input: z.record(z.unknown()).optional(),
  // 上限必须覆盖人工确认门禁的默认超时（1 小时）：曾写死 10 分钟，导致"达人邀约"这类
  // 把门禁 timeoutMs 设成 30 分钟的任务在创建阶段就被拒（实测报 steps[N].timeoutMs too_big）
  timeoutMs: z.number().int().min(500).max(3600000).optional(),
  retryLimit: z.number().int().min(0).max(5).optional()
}).strict())

export const stepInputSchemas: Record<string, z.ZodSchema> = {
  navigate: z.object({ url: httpUrl }).strict(),
  waitForPage: z.object({ urlIncludes: z.string().max(300).optional() }).strict(),
  // deep = 穿透 ShadowRoot 查询（微信小店整页在 micro-app 的 ShadowRoot 里）
  waitForSelector: z.object({ selector, deep: z.boolean().optional() }).strict(),
  readText: z.object({ selector, metric: z.string().min(1).max(60).optional(), deep: z.boolean().optional() }).strict(),
  // keepRows：把整表行数组落快照（发票中心要展示"待开票信息"的内容）；默认只落行数
  // pickByHeader：页面上有多张表时，挑表内含该文案的那一张（实测微信发票中心有 2 张日历表）
  // mergeHeaderTable：表头与数据分属两个 <table> 时（实测拼多多），把表头表的下一张也读进来
  // expectHeaders：表头必须包含这些列名，否则如实失败（发票中心按开票方向校验：
  //   页内切方向没生效时会读到上一个方向的表，必须失败而不是错报）
  readTable: z.object({
    selector,
    metric: z.string().min(1).max(60).optional(),
    deep: z.boolean().optional(),
    keepRows: z.boolean().optional(),
    pickByHeader: z.string().min(1).max(60).optional(),
    mergeHeaderTable: z.boolean().optional(),
    expectHeaders: z.array(z.string().min(1).max(60)).max(20).optional(),
    /**
     * 读到含这些列名的表就不采信（那是**别的开票方向**的表：页内切页签没生效，
     * 而本方向自己恰好没有表——不给判据就会把上一个方向的数据重复报成本方向的）。
     */
    rejectHeaders: z.array(z.string().min(1).max(60)).max(20).optional(),
    /**
     * 该表**本来就可能没有**（发票页某些开票方向就是空的：实测微信「给买家开票」
     * 整页没有账单表、抖店「给消费者开票」结构未验）。
     * 给了它：挑不到表/表头不符不报错，改落一条**空快照**（如实 0 条），
     * 界面显示"0 条"而不是"采集失败"。
     */
    emptyOk: z.boolean().optional()
  }).strict(),
  screenshot: z.object({}).strict(),
  fillDraft: z.object({ selector, text: z.string().max(20000) }).strict(),
  waitForUserConfirmation: z.object({ message: z.string().min(1).max(500) }).strict(),
  // 副作用步骤（点击/写入）：参数仍然只有选择器与文本，无任何代码入口
  click: z.object({ selector }).strict(),
  // mode:'real' = 受信任鼠标点击（定位元素中心 → 滚动可见 → sendInputEvent），
  // 用于框架对合成 click 不响应的目标；deep 同上穿透 ShadowRoot；within = 限定查找范围
  clickByText: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    mode: z.enum(['js', 'real']).optional(),
    within: within.optional(),
    /**
     * 找不到目标时用的错误码（默认 TASK_SELECTOR_CHANGED）。
     * 批量循环里用它可以区分"页面改版找不到了"和"没有下一个候选了"：
     * 例如微信按列表逐个邀约时，点「详情」找不到 = 没有更多达人了，
     * 给它 TASK_SELECTION_SHORTFALL，loop 就会**干净停止**而不是报失败。
     */
    missingCode: z.string().min(1).max(40).optional(),
    /**
     * 目标处于禁用态时用的错误码（默认 TASK_TARGET_DISABLED）。
     * 用途：翻页按钮在最后一页会被平台置灰——那个禁用不是"平台限制操作"，
     * 而是"没有更多了"，交给它 TASK_SELECTION_SHORTFALL 就能干净收工。
     */
    disabledCode: z.string().min(1).max(40).optional(),
    /**
     * 点完可能在新标签页打开时用（微信达人广场实测：「详情」是 window.open，
     * 页面本身不跳转）。给了它就等新标签页出现、把本次运行切到新标签页上继续，
     * 并默认关掉旧的运行标签页（否则每个候选都留一个标签页）。
     * 后续紧跟的 waitForPage 仍会独立校验地址——这里只是"跟过去"，不做断言。
     */
    followTab: z.object({
      urlIncludes: z.string().min(1).max(300).optional(),
      closeOld: z.boolean().optional()
    }).strict().optional(),
    /**
     * 点击后应当发生的**同标签页跳转**：`{ includes, attempts? }`。
     * 给了它就：点击 → 轮询当前地址是否含 includes；未出现则重新定位再点一次（最多 attempts 次，默认 3）。
     * 用途：微信详情页「邀请带货」是 SPA 内部 pushState，按钮早早就在 DOM 里但事件尚未挂上，
     * 点早了会被丢弃——固定 sleep 不可靠（实测 3s 失败、4s 成功），轮询+重试才是稳的。
     */
    waitUrl: z.object({
      includes: z.string().min(1).max(300),
      attempts: z.number().int().min(1).max(8).optional()
    }).strict().optional(),
    /**
     * nth:'round' —— 取"列表里第 N 条"（N = 当前循环轮次，1 起）。
     * nth:'unvisited' —— 取**第一条本次运行还没点过的**（按行容器文本去重，点过就记住）。
     *   微信广场实测：列表每次加载都会重新洗牌（同样地址、首行每次不同），
     *   所以"第 N 条"并不能保证换人；"还没点过的第一条"才是不会重复邀约同一人的判据。
     *   当前页全都点过 = 该页取不出（配 missingCode 让 loop 翻页后重试）。
     */
    nth: z.enum(['round', 'unvisited']).optional(),
    /**
     * 窗口视图未挂载（渲染层弹层遮挡 → 原生视图被摘除 → 页面视口 0×0）时，
     * 是否允许降级为 JS 点击。
     *
     * 只给**纯页内状态切换**的点击开（切页签、切筛选）：那种点击点了之后页面自己重渲染，
     * 不依赖浏览器输入管线。默认 false = 如实报 TASK_VIEW_DETACHED。
     * 依赖框架真实输入的按钮（微信邀约表单）**绝不能**开：JS 合成 click 对它们不生效，
     * 开了会静默点空、把根因推到后面几步才暴露。
     */
    allowJsWhenDetached: z.boolean().optional(),
    /**
     * 点完校验它**真的选中了**：`{ selector, classIncludes, text? }` ——
     * 在 selector 匹配的元素里找一个 innerText === text（默认 = 本次点的文案）且 className
     * 含 classIncludes 的，超时没有就报 TASK_TAB_NOT_ACTIVE。
     *
     * 用途：平台常有一批**表头完全相同**的页签（实测快手发票页「处理中」与「处理记录」），
     * 切页签静默失败时读回来的是上一个页签的数据，而表头校验对此无能为力——
     * 有了它切不动就如实失败，不会张冠李戴。
     */
    verifyActive: z.object({
      selector,
      classIncludes: z.string().min(1).max(60),
      text: z.string().min(1).max(200).optional()
    }).strict().optional()
  }).strict().refine((v) => !v.nth || v.mode === 'real', { message: 'nth 仅支持 mode:"real"（需要真实鼠标点击）' }),
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
  waitForText: z.object({ text: z.string().min(1).max(200), deep: z.boolean().optional(), within: within.optional() }).strict(),
  ensureRows: z.object({
    rowsSelector: selector,
    checkboxSelector: selector,
    addText: z.string().min(1).max(100),
    confirmText: z.string().min(1).max(100),
    min: z.number().int().min(0).max(100).optional(),
    max: z.number().int().min(1).max(100),
    deep: z.boolean().optional()
  }).strict(),
  // 按商品ID指定的商品添加（微信小店邀约商品弹窗）
  ensureRowsById: z.object({
    rowsSelector: selector,
    checkboxSelector: selector,
    addText: z.string().min(1).max(100),
    confirmText: z.string().min(1).max(100),
    /** 商品ID 数组：在弹窗列表里按文本包含搜索并勾选指定行 */
    productIds: z.array(z.string().min(1).max(40)).min(1).max(30),
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
    maxValueLen: z.number().int().min(1).max(200).optional(),
    /**
     * 该标签的值本来就不是数字（公司名 / "2026年05/06月"这类文本）→ 原样取用文本，
     * 不做数值抽取。默认 false = 必须取到数字（数据中心指标卡那种场景）。
     */
    allowText: z.boolean().optional()
  }).strict(),
  // 显式等待（读型步骤，上限 2 分钟）：等 SPA 按新筛选条件刷新数据
  waitMs: z.object({ ms: z.number().int().min(100).max(120000) }).strict(),
  // 等元素消失/不可见（读型步骤）：提交后校验结果（如邀约抽屉应关闭）
  waitForGone: z.object({ selector, deep: z.boolean().optional() }).strict(),
  // 切到已打开的某个标签页（不导航）：微信邀约逐轮换人时回到"一直活着的"广场页——
  // 重载会重置分页与筛选（平台翻页是内部状态、URL 不变）。path 按 pathname 精确匹配，
  // urlIncludes 按子串匹配（path 更稳妥，避免 '/find' 前缀误命中 '/finder-detail'）。
  useTab: z.object({
    path: z.string().min(1).max(300).optional(),
    urlIncludes: z.string().min(1).max(300).optional(),
    // 默认关掉切换前的运行标签页（详情/表单页用完即关，否则轮次一多窗口堆满）
    closeCurrent: z.boolean().optional()
  }).strict().refine((v) => !!v.path !== !!v.urlIncludes, { message: 'useTab 的 path 与 urlIncludes 必须二选一' }),
  /**
   * 批次循环：把"一轮完整动作"（如 筛选→勾 40 位→批量邀约→确认发送）重复执行。
   *   - stopOn：命中这些错误码即**干净停止**（本轮记入 summary、不再继续、整个 run 仍成功）。
   *     用途："邀约额度用完"（确认发送变禁用 → TASK_QUOTA_EXCEEDED）与"可选达人不足"
   *     （TASK_SELECTION_SHORTFALL）都算正常收尾，不是失败；
   *   - onCode：命中这些错误码时**先跑恢复步骤、再把本轮同一个子步骤重跑**（最多 recoverLimit 次）。
   *     用途：微信广场"本页达人都已邀约过"（TASK_PAGE_EXHAUSTED）→ 点「下一页」→ 重试取人；
   *     与 stopOn 的区别：stopOn 是收工，onCode 是"换个条件继续干"；
   *   - 其它错误照常向上抛 → run 如实失败（不吞错、不假装成功）；
   *   - 嵌套步骤逐个走白名单校验（task-store 递归校验），且整步不可恢复（会重复发送）。
   */
  loop: z.object({
    label: z.string().max(60).optional(),
    maxRounds: z.number().int().min(1).max(50),
    stopOn: z.array(z.string().min(1).max(40)).min(1).max(8),
    onCode: z.array(z.object({
      code: z.string().min(1).max(40),
      // 恢复动作（如「点下一页」）；同样逐条走白名单校验
      steps: z.array(taskStepSchema).min(1).max(10),
      // 本轮内最多恢复几次（防止"翻页点不动"时空转）
      limit: z.number().int().min(1).max(10).optional(),
      /**
       * restart=true：命中后**重开本轮**（而不是重试当前子步骤）。
       * 用途：这一位达人打不开（平台间歇性渲染失败）→ 记下他、回广场取下一位继续。
       * limit 在 restart 语义下表示"**连续**跳过多少轮后放弃"（跨轮累计，成功一轮即清零），
       * 防止平台整体故障时静默跳过所有人。
       */
      restart: z.boolean().optional()
    }).strict()).max(4).optional(),
    // 一轮动作的步骤数上限：抖店一轮 ≈ 17–28 步（含多等级/多权益），给到 40 步余量
    steps: z.array(taskStepSchema).min(1).max(40)
  }).strict()
}

/** 副作用步骤不可进入"从失败恢复"的重试范围 - §9.2（重试会重复点击/重复写入） */
export const NON_RESUMABLE_TYPES: ReadonlySet<string> = new Set([
  'fillDraft', 'waitForUserConfirmation',
  'click', 'clickByText', 'clickAll', 'setInput', 'aiGenerate',
  // 微信小店流程的副作用步骤同样不可重复执行（重复点击=重复发送风险）
  'typeText', 'ensureRows', 'ensureRowsById',
  // 切标签页是运行态操作（tabId 会被改写），重放没有意义
  'useTab',
  // 循环体里通常含点击/写入（一循环就是一轮真实发送），整步不可重放
  'loop'
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
  ensureRowsById: 120000,
  requireQuota: 30000,
  requireEnabled: 20000,
  readLabelValue: 25000,
  waitMs: 120000,
  waitForGone: 30000,
  useTab: 30000,
  // loop 的 timeoutMs 不参与实际计时（由内部各步骤自己的超时决定）；
  // 这里给个展示用的大值，避免界面上显示成 15s 起步的时间
  loop: 3600000
}

export const taskCreateSchema = z.object({
  name: z.string().min(1).max(80),
  storeScope: z.string().max(80).nullish(),
  steps: z.array(taskStepSchema).min(1).max(30),
  schedule: z.object({ everyMs: z.number().int().min(60000).max(30 * 86400000) }).nullish()
})
