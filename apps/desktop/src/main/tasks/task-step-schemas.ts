/**
 * 任务步骤输入的白名单 Zod schema（§5.6）
 * 独立成文件：只依赖 zod 与 shared 常量，可被单测直接导入
 * （task-store.ts 依赖 SQLite/Electron，无法在 vitest 下加载）。
 * 步骤只允许预定义类型；输入 JSON 一律 Zod 校验（§5.6）。
 */

import { z } from 'zod'
import { TASK_STEP_TYPES } from '@shared/schemas/task'
import { AGENT_NON_RESUMABLE_STEP_TYPES, isIdempotentCheckboxFilterStep, isIdempotentStepType } from '@shared/agent-step-effects'
import { agentScheduleSchema } from '@shared/schemas/agent'

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
  /**
   * `code` / `hint`：等不到时的**错误码与说明**（2026-10-04 加）。
   * 动机：快手点「批量邀约」后抽屉没开（平台把近 7 天已邀的达人静默剔除、一位都没发出去），
   * 旧写法只报 `TASK_TIMEOUT: 等待选择器…`——看日志的人只会以为页面卡了。
   * 有了独立码，loop 才能把它当"按预期收工"（stopOn）而不是"任务失败"。
   */
  waitForSelector: z.object({ selector, deep: z.boolean().optional(), code: z.string().min(1).max(40).optional(), hint: z.string().max(300).optional() }).strict(),
  readText: z.object({
    selector, metric: z.string().min(1).max(60).optional(), deep: z.boolean().optional(),
    /** Agent 读取页面时必须开启：先脱敏再进入 task_step_results。 */
    privacyRedact: z.boolean().optional()
  }).strict(),
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
    /** 只返回表头和行数，不把订单/客户单元格内容送入 Main 或写入任务结果。 */
    headersOnly: z.boolean().optional(),
    /**
     * 该表**本来就可能没有**（发票页某些开票方向就是空的：实测微信「给买家开票」
     * 整页没有账单表、抖店「给消费者开票」结构未验）。
     * 给了它：挑不到表/表头不符不报错，改落一条**空快照**（如实 0 条），
     * 界面显示"0 条"而不是"采集失败"。
     */
    emptyOk: z.boolean().optional()
  }).strict().refine(v => !(v.headersOnly && v.keepRows), {
    message: 'headersOnly 与 keepRows 不能同时启用'
  }),
  screenshot: z.object({}).strict(),
  fillDraft: z.object({ selector, text: z.string().max(20000) }).strict(),
  waitForUserConfirmation: z.object({ message: z.string().min(1).max(500) }).strict(),
  // 副作用步骤（点击/写入）：参数仍然只有选择器与文本，无任何代码入口
  click: z.object({
    selector,
    // mode:'real' = 受信任鼠标点击（按选择器定位 → sendInputEvent）。
    // 用途：没有稳定文案、且合成 click 不响应的控件——实测抖店抽屉「主营」级联的触发器
    // （合成 click 打不开下拉），而它的文案会随平台记忆变化，只能按选择器定位。
    mode: z.enum(['js', 'real']).optional()
  }).strict(),
  // mode:'real' = 受信任鼠标点击（定位元素中心 → 滚动可见 → sendInputEvent），
  // 用于框架对合成 click 不响应的目标；deep 同上穿透 ShadowRoot；within = 限定查找范围
  clickByText: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    mode: z.enum(['js', 'real']).optional(),
    exact: z.boolean().optional(),
    /**
     * 已勾选就跳过（不点）。用于**平台会记住上次填写**的复选组/级联项：
     * 批量循环第 2 轮起抽屉里是带记忆的状态，照旧点一遍会把上一轮的勾选**取消掉**
     * （实测抖店抽屉：核心优势/权益/主营都会保留，重复点击等于反选）。
     */
    skipIfChecked: z.boolean().optional(),
    /**
     * 跳过"所在行文本含这些文案"的候选（2026-10-04）。
     * 用途：**7 天内邀过的达人不再重复邀约** —— 台账里的昵称清单从这里进来，
     * 点「详情」之前就把那些行剔掉，省掉一次详情页访问；全被剔掉则交给 loop 翻页。
     */
    skipTexts: z.array(z.string().min(1).max(120)).max(500).optional(),
    /** 命中后回传"这一行的达人昵称"（供引擎写邀约台账） */
    recordRowText: z.boolean().optional(),
    /**
     * "找不到目标就先点这个开关"（2026-10-04 加）。
     *
     * 真机场景：微信广场「带货销售总额」下拉里的档位。下拉面板收起时档位是 display:none、
     * 引擎的可见性判据直接报"找不到"；而 DT 是**开关**（点开/点收），
     * 上一轮如果因为页面重渲染把"收起"点丢了，这一轮先点一次"开"就变成了"收"——
     * 于是第 13 轮死在 `TASK_SELECTOR_CHANGED: 页面上找不到「不限」`（用户真机实测）。
     * 用 openVia 表达"目标不可见时才去点开关"，就同时兼容"面板已开"与"面板已收"两种前置状态。
     */
    openVia: z.object({ text: z.string().min(1).max(120), exact: z.boolean().optional(), deep: z.boolean().optional() }).strict().optional(),
    /**
     * "只有这段文案可见时才点"（2026-10-04 加）：用于**条件性收尾**，例如把指标下拉收起来——
     * 面板已经收起时不该再点（那会把面板点开，反而盖住列表）。
     * `within` 用于把判据限定在具体容器里（例如"某个指标 dl 内的档位"），
     * 否则同一段文案在表格/摘要里出现就会误判成"面板开着"。
     */
    onlyIfVisible: z.object({ text: z.string().min(1).max(120), deep: z.boolean().optional(), within: within.optional() }).strict().optional(),
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
     * 目标不存在时，若页面上出现这段**替代文案**，就立刻按 absentCode 失败（不等超时）。
     *
     * 用途：平台用"另一种说法"表达"这件事做不了，但页面本身是正常的"——
     * 实测微信达人详情页：可邀约的显示「邀请带货」，不达合作门槛的显示
     * 「暂未到达合作门槛」（页面渲染完好，只是这位达人不能邀约）。
     * 不区分的话，这两件事会被同一个错误码混在一起：前者是"页面没渲染出来"（等一下还能好），
     * 后者是"这位达人天生不能邀约"（等多久都一样）——而"等下一位"与"重试同一位"是完全相反的处理。
     */
    absentText: z.string().min(1).max(200).optional(),
    /** absentText 命中时的错误码（默认 TASK_SELECTOR_CHANGED） */
    absentCode: z.string().min(1).max(40).optional(),
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
     * 给了它就：点击 → 轮询当前地址是否含 includes；未出现则重新定位再点一次（最多 attempts 次）。
     * **默认 1 = 不重发点击**：重发会真的再点一次，只对"点不生效时再点也不产生第二次提交"的
     * 导航触发类安全——必须是任务作者显式声明的意图（如微信「邀请带货」写 attempts:4，
     * 它只跳表单页、真正发送在后面一步）。会提交的步骤别写 attempts，宁可超时让人重跑。
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
     * 页面视口塌陷（DOM <webview> 的 guest 尚未注册 / 页面被移出文档 / 平台折叠内容区）时，
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
    }).strict().optional(),
    /**
     * 点完校验它**真的处于勾选态**（读回目标自己或所属 label 里的 checkbox.checked）。
     *
     * 用途（真机实测驱动，2026-10-02 微信小店带货者广场）：有的平台把"筛选到底生效没有"
     * **只**表达在控件勾选态上——「带货销售总额」的下拉区间选完即生效、浮层自己收起，
     * 而 DT 文案永远是指标名、页面也没有「已筛选」摘要，"点过了"与"筛上了"在页面上无从区分。
     * 筛选静默失效＝把不该邀的达人放进名单，所以这里宁可如实失败（默认错误码
     * TASK_FILTER_NOT_APPLIED），也不能把一次无效点击当成成功。
     */
    verifyChecked: z.boolean().optional(),
    /** verifyChecked 失败时的错误码（默认 TASK_FILTER_NOT_APPLIED） */
    verifyCode: z.string().min(1).max(40).optional()
  }).strict().refine((v) => !v.nth || v.mode === 'real', { message: 'nth 仅支持 mode:"real"（需要真实鼠标点击）' }),
  // 条件点击：目标出现就点、没出现就跳过（不入库失败）。
  // 用途：平台**可能**弹二次确认框（没实测到确定行为时不能硬等，也不能假设没有）——
  // 硬等会白等超时、假设没有则可能"点了发送却没真的发出去"。用它把两种可能都覆盖，
  // 并把"到底有没有出现过"如实记进步骤结果。
  clickIfPresent: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    /** 等待时长（ms）：这段时间内出现就点；超时未出现按"没有这个确认框"处理 */
    waitMs: z.number().int().min(500).max(60000).optional(),
    /**
     * 只在"包含这段文案的最近祖先"里找目标。
     *
     * 为什么需要：同一页面上常有多个**同名按钮**（实测快手：商品弹窗与它上面弹出的
     * 「商品不符合达人带货要求」确认框都叫「确认」），按文案找会命中先出现的那个（下层弹窗的），
     * 点了等于白点、上层确认框一直留着。给一段**只属于该确认框**的文案当锚点即可精确定位。
     */
    nearText: z.string().min(1).max(200).optional()
  }).strict(),
  /**
   * 悬停：把鼠标移到文案为 text 的元素上（**不点击**），用于展开多列级联菜单的下一列。
   *
   * 实测动因（抖店达人广场「主推类目」，2026-09-22 真机）：
   *   · 点一级 chip 只展开第一列（二级项）；
   *   · 二级项**悬停**才渲染出第三列（三级项）；
   *   · 直接点二级项 = 只应用「一级/二级」并把整个弹层收起——于是"点二级、再点三级"
   *     这条老路径必然失败（弹层已收，三级项不可见）。
   * 所以三级筛选的正确手势是：悬停二级 → 点三级。悬停不改变平台数据，可安全重放。
   * exact：整段精确匹配（避免「纸品」命中「纸品用品」）；within：限定在哪一列/哪个弹层里悬停。
   */
  hover: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    exact: z.boolean().optional(),
    within: within.optional()
  }).strict(),
  // 按键（白名单只允许 Escape）：用于收起页面上残留的下拉浮层。
  // 实测快手选完「带货类目」后级联下拉仍展开，会盖住后续要点的按钮（商品弹窗的「确 认」）。
  pressKey: z.object({
    key: z.enum(['Escape'])
  }).strict(),
  clickAll: z.object({
    selector: selector.optional(),
    text: z.string().min(1).max(200).optional(),
    // 上限 100 = 各平台档案登记的最大单次批量数（快手 maxBatch=100）；抖店的 40 由档案负责夹取
    // （invite-task 按 profile.maxBatch 收口）。此前写死 40 是照抖店抄的平台常量 → 快手邀约
    // 填 41–100 位时面板放行、这里拒绝，功能不可用（2026-09-28 审查确认）。
    max: z.number().int().min(1).max(100),
    // scroll=true：点完当前可点的行后向下滚动列表继续选（虚拟滚动/滚动加载的列表，如抖店广场）
    scroll: z.boolean().optional(),
    // 滚动续选的最大轮数（防止无进展时空转）
    maxRounds: z.number().int().min(1).max(60).optional(),
    /**
     * 这些元素**不算候选**（按选择器命中即跳过）。
     * 用途：表头的"全选"复选框往往落在同一选择器范围内（实测快手商品弹窗），
     * 它会被当成一个候选（点它会全选，不是"勾 N 个"）。
     */
    skipSelector: z.string().min(1).max(300).optional(),
    /**
     * 页面计数文案必须包含这段字才算"本次操作的计数"。
     * 同一页面上有多个「已选N…」时用它消歧义——实测快手：在商品弹窗里勾选时，
     * 页面上达人选人区的「已选2条」还在，被当成本次计数 → progress 恒为 0 →
     * 误报"只勾中 0 位"（其实商品勾上了）。给了它才启用宽松计数写法。
     */
    counterIncludes: z.string().min(1).max(40).optional(),
    /**
     * 行文本包含这些词的**不勾**（2026-10-04 加，快手真机动机）。
     *
     * 快手广场点「批量邀约」时，平台会把**近 7 天内已邀过（含被拒）的达人静默剔除**，
     * 而列表行上没有任何"已邀约"标记（真机逐行量过）。全被剔除时这次点击等于没发生
     * （选择被清空、抽屉不开），整批就在"等抽屉"上白等到超时。
     * 台账里记着我们自己近 7 天邀过的昵称 → 勾选时直接跳过这些行，别让平台替我们剔。
     */
    skipTexts: z.array(z.string().min(1).max(120)).max(500).optional()
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
  waitForText: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    exact: z.boolean().optional(),
    token: z.boolean().optional(),
    within: within.optional()
  }).strict().refine(input => !(input.exact && input.token), {
    message: 'exact 与 token 不能同时启用',
    path: ['token']
  }),
  ensureRows: z.object({
    rowsSelector: selector,
    checkboxSelector: selector,
    addText: z.string().min(1).max(100),
    confirmText: z.string().min(1).max(100),
    min: z.number().int().min(0).max(100).optional(),
    max: z.number().int().min(1).max(100),
    deep: z.boolean().optional(),
    /**
     * 确认按钮点完后，**这个容器应当消失**才算是生效（弹窗式选择器的结果校验）。
     * 不给则按 rowsSelector 的行数复核（列表式抽屉用）。
     * 实测动机：快手「选择商品」是弹窗，确认后弹窗关闭、行不在当前页面上，
     * 按行数复核会读到 0 并误报失败；等弹窗消失才是"确认被接受"的正证据。
     */
    confirmClosesSelector: selector.optional()
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
    deep: z.boolean().optional(),
    /** 失败时给用户的提示（与 requireEnabled 一致；额度不足时说明"为什么停") */
    hint: z.string().max(200).optional(),
    /**
     * 不满足时抛的错误码（默认 TASK_QUOTA_EXCEEDED）。
     * 为什么要能改：本步骤其实是通用的"某处数字 ≥ min"断言。
     * 断言**额度**时用默认码（loop 的 stopOn 会当成"额度用完"正常收尾）；
     * 断言**别的东西**时（如"已选商品数 ≥ 1"）必须换一个不在 stopOn 里的码，
     * 否则会把"商品没选上"当成"按预期收工"，静默地没发出去（最危险的一类错）。
     */
    code: z.string().min(1).max(40).optional()
  }).strict(),
  // 可用性预检（读型步骤）：文案为 text 的可见按钮若禁用则如实失败
  requireEnabled: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    hint: z.string().max(200).optional(),
    /**
     * **平台表达"额度用尽"的禁用文案**（登记后本步才把禁用当成额度用尽＝按预期收尾）。
     *
     * 为什么需要它：禁用态本身不带原因——平台可能因为"额度用尽"禁用，也可能因为
     * "必填未填/未登录/风控"禁用。此前一律当额度用尽，而 `TASK_QUOTA_EXCEEDED` 在邀约
     * 循环的 `stopOn` 里＝**按预期成功收尾**，于是"按钮因别的原因被禁用"会变成
     * "任务报成功、一位都没发出去"（2026-09-28 审查确认的静默假成功）。
     * 现在只认声明过的文案（引擎会去读按钮旁的 tooltip/popover 说明），
     * 读不到或不匹配 → 如实失败（`TASK_TARGET_DISABLED_UNCERTAIN`），不再默认当额度用尽。
     */
    quotaDisabledIncludes: z.array(z.string().min(1).max(120)).max(8).optional(),
    /**
     * **平台档案显式声明**：这个按钮的禁用态就等于"额度用尽"（实测校准的事实）。
     *
     * 与 `quotaDisabledIncludes` 的区别：后者靠"读到按钮旁的文案再比对"（更精确，优先），
     * 本字段是"读不到文案时的平台声明"。两者都**必须显式给出**——引擎不再默认
     * "禁用=额度用尽"（那是静默假成功的来源）。抖店的「确认发送」就是靠本字段按额度用尽收尾。
     */
    disabledMeansQuota: z.boolean().optional()
  }).strict(),
  /**
   * 文案缺席断言（读型步骤）：页面上**不该出现**这段文案；出现即按 code 如实失败。
   *
   * 用途（真机实测驱动）：提交类动作之后，平台会**用文案告诉我们它拒绝了**——
   * 快手点「发送邀请」后弹「部分邀约发送失败」，并且**故意把抽屉留着**（让你调整后重试）。
   * 于是"抽屉没关"既可能是失败、也可能只是平台还在处理，区分不出来；
   * 只有读这段失败文案，才能如实报出"这一批其实没发出去"。
   */
  requireTextAbsent: z.object({
    text: z.string().min(1).max(200),
    deep: z.boolean().optional(),
    /** 命中时抛出的错误码（默认 TASK_TEXT_PRESENT） */
    code: z.string().min(1).max(40).optional(),
    hint: z.string().max(300).optional(),
    /**
     * 命中前的最长轮询时间（ms，默认 5000）。给一点余量：弹窗可能比返回值晚一拍渲染出来；
     * 但不能给太长——这段文案一旦出现就是**确定性的拒绝**，不需要等。
     */
    waitMs: z.number().int().min(0).max(60000).optional()
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
    allowText: z.boolean().optional(),
    /**
     * 「页面上没有这一行」算通过（与 readTable 的 emptyOk 同一思路）。
     * 用途：同一个信息的行文案随**主体类型**变（实测快手个体工商户是「个体工商户名称」、
     * 企业应为「企业名称」），两个候选都读、谁在取谁；个人店铺本来就两行都没有。
     * 注意它只豁免 NOT_FOUND（标签全文都不在页面上）；标签在、但旁白取不到值的
     * NO_VALUE_SIBLING / VALUE_TOO_LONG 仍然如实失败——那才是"页面结构变了"。
     */
    absentOk: z.boolean().optional(),
    /** Agent 读取时脱敏结果后再保存。 */
    privacyRedact: z.boolean().optional()
  }).strict(),
  // 显式等待（读型步骤，上限 2 分钟）：等 SPA 按新筛选条件刷新数据
  waitMs: z.object({ ms: z.number().int().min(100).max(120000) }).strict(),
  // 等元素消失/不可见（读型步骤）：提交后校验结果（如邀约抽屉应关闭）。
  // 2026-10-03 起也支持 `text`：等"某段可见文案消失"。微信邀约发送后要确认**弹窗真的关了**
  // ——弹窗是平台通用组件、没有稳定选择器，只能按文案等（实测文案「确认发送邀约」）。
  // 二者必须给一个且只能给一个（都缺 = 等了个寂寞，都给 = 判据含糊）。
  waitForGone: z.object({ selector: selector.optional(), text: z.string().min(1).max(200).optional(), deep: z.boolean().optional() })
    .strict()
    .refine(value => Boolean(value.selector) !== Boolean(value.text), { message: 'selector 与 text 必须二选一' }),
  // 切到已打开的某个标签页（不导航）：微信邀约逐轮换人时回到"一直活着的"广场页——
  // 重载会重置分页与筛选（平台翻页是内部状态、URL 不变）。path 按 pathname 精确匹配，
  // urlIncludes 按子串匹配（path 更稳妥，避免 '/find' 前缀误命中 '/finder-detail'）。
  useTab: z.object({
    /** 精确切换到同店铺中已打开的标签页；只供 Agent 固定当前上下文。 */
    tabId: z.string().min(1).max(100).optional(),
    path: z.string().min(1).max(300).optional(),
    urlIncludes: z.string().min(1).max(300).optional(),
    // 默认关掉切换前的运行标签页（详情/表单页用完即关，否则轮次一多窗口堆满）
    closeCurrent: z.boolean().optional()
  }).strict().refine((v) => [v.tabId, v.path, v.urlIncludes].filter(Boolean).length === 1, {
    message: 'useTab 的 tabId、path 与 urlIncludes 必须且只能指定一个'
  }),
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
    /** 平台名（微信小店/抖店…）：仅用于写"邀约台账"时留档，不参与任何点击逻辑 */
    platform: z.string().max(40).optional(),
    maxRounds: z.number().int().min(1).max(50),
    stopOn: z.array(z.string().min(1).max(40)).min(1).max(8),
    onCode: z.array(z.object({
      code: z.string().min(1).max(40),
      // 恢复动作（如「点下一页」）；同样逐条走白名单校验
      steps: z.array(taskStepSchema).min(1).max(10),
      /**
       * 本轮内最多恢复几次（防止"翻页点不动"时空转）。
       *
       * 上限从 30 提到 60（2026-10-04）：用户要求"7 天内邀过的达人不再重复邀约"，
       * 而平台的"已邀约"标记**只在详情页**（列表行没有，真机实测），本地台账又只能覆盖我们自己邀过的
       * ——手工邀过的人只能靠平台兜底：点进详情页发现按钮禁用 → TASK_DAREN_ALREADY_INVITED → advance 跳过。
       * 连着遇到 20~30 位已邀过的（发过几轮之后很正常）就会把上限耗尽而**误判成平台异常收工**。
       */
      limit: z.number().int().min(1).max(60).optional(),
      /**
       * restart=true：命中后**重开本轮**（而不是重试当前子步骤）。
       * 用途：这一位达人打不开（平台间歇性渲染失败）→ 记下他、回广场取下一位继续。
       * limit 在 restart 语义下表示"**连续**跳过多少轮后放弃"（跨轮累计，成功一轮即清零），
       * 防止平台整体故障时静默跳过所有人。
       */
      restart: z.boolean().optional(),
      /**
       * advance=true：命中后**重开本轮，但保留本轮的"已访问"记录** —— 即"跳过这一位、换下一位"。
       * 与 restart 的唯一差别就是那条记录（restart 要回滚它才能在重试时**再选中同一位**）：
       * 用途：页面正常、但平台明说这一位不满足合作条件（微信详情页「暂未到达合作门槛」）。
       * 重试同一位永远没用，必须换人；用 restart 会因为回滚记录而原地打转。
       * limit 同为"连续跳过多少位后放弃"（成功邀约一位即清零）。
       */
      advance: z.boolean().optional()
    }).strict()).max(4).optional(),
    // 一轮动作的步骤数上限。原先 40（抖店一轮 ≈ 17–28 步，含多等级/多权益）。
    // 提到 80 是因为微信小店的辅助流把**广场筛选搬进了轮内**（2026-10-03 真机实测：
    // 切到详情页再切回来时广场页会被重新加载、页内筛选随之丢失，所以必须每轮重新应用）：
    // 一份把可选项全选上的极端配置 = 类型 1 + 类目 34 + 销售总额 16+2 + 其他 7 步筛选 +
    // 一轮邀约动作 ≈ 18 步 ≈ 78 步。上限给到 80 只是"允许合法配置建得出来"，
    // 不会让任何一步绕过白名单校验（嵌套步骤仍逐条过 taskStepSchema）。
    steps: z.array(taskStepSchema).min(1).max(80)
  }).strict()
}

/**
 * 副作用步骤不可进入"从失败恢复"的重试范围 - §9.2（重试会重复点击/重复写入）
 *
 * 名单来自 `@shared/agent-step-effects` 的单一事实来源：这里以前自己维护一份 13 项的列表，
 * 而 `agent-domain-rules.deriveJobRisk` 用文案正则、`agent-planner.SIDE_EFFECT_TYPES` 只有 2 项，
 * 三份口径打架（审计 P0-1）。现在三处同源，`tests/unit/agent-step-effects.test.ts` 用集合同一性锁死。
 */
export const NON_RESUMABLE_TYPES: ReadonlySet<string> = AGENT_NON_RESUMABLE_STEP_TYPES

/**
 * 归一化 `retryLimit`：**非幂等步骤强制为 0**（`click*` 重试=重复提交，`loop` 重试=整多跑一轮）。
 *
 * 为什么要在**主进程**再挡一次：编辑器侧（`@shared/custom-task`）本来会报错拦人，但那只覆盖
 * "用户走编辑器"这一条路；`task:create` / `task:update` 是直落库的通道（粘贴 JSON、导入、
 * 将来的第三方调用方），主进程是唯一的信任边界——同一条规则写在两处必然漂移（2026-09-28 审查
 * 证实：主进程侧此前完全没有这道闸）。
 *
 * 判定用 `@shared/agent-step-effects` 的 `isIdempotentStepType`（单一事实来源），
 * 与 `custom-task.STEP_CATALOG.idempotent` 一致（有单测锁死两者等价）。
 *
 * 口径是"归一化"而不是"抛错"：用户已存的旧任务行里可能就带着非幂等步骤的 retryLimit，
 * 抛错会让这些任务直接无法加载/无法编辑；归零既安全又不破坏兼容。
 */
export function normalizeStepRetryLimit(type: string, retryLimit?: number | null, input?: unknown): number {
  const n = Number(retryLimit)
  if (!Number.isFinite(n) || n <= 0) return 0
  /**
   * 除了幂等类型，**还有一类"构造上幂等"的点击**：带 `skipIfChecked + verifyChecked` 的复选框筛选。
   *
   * 为什么它能重试（2026-10-04 真机：用户连发时第 1 轮就死在
   * `TASK_FILTER_NOT_APPLIED: 「母婴」点了但没有生效`）：这类步骤重跑一次是安全的——
   *   · 已经勾上了 → skipIfChecked 命中，**不点**，直接通过；
   *   · 还没勾上 → 重新定位再点一次（页面重渲染后旧坐标/旧节点会失效，这正是失败原因）。
   * 与"重复提交"完全不同：它没有任何不可逆副作用，且勾选态就是它的幂等判据。
   */
  const checkboxFilter = isIdempotentCheckboxFilterStep(type, input)
  if (!isIdempotentStepType(type) && !checkboxFilter) return 0
  return Math.min(5, Math.trunc(n))
}

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
  clickIfPresent: 30000,
  hover: 15000,
  pressKey: 10000,
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
  // Long Agent jobs are still bounded and each step remains whitelist-validated;
  // the old 30-step ceiling made a large but legitimate workflow fail before
  // it could reach TaskRunner.
  steps: z.array(taskStepSchema).min(1).max(100),
  // 复用 agent 那份 schedule schema：定义两处必然漂移——2026-09-29 实测，主进程这份没有 backgroundOpen，
  // parse 时把调用方传的 backgroundOpen 静默strip 掉，于是定时任务后台开页面的开关永远为假。
  schedule: agentScheduleSchema.nullish()
})
