/**
 * 发票中心「平台档案」（抓取各平台**待开票信息**用）
 *
 * 数据从哪来：本应用没有平台官方 API，只能从各平台后台的发票/开票页面读取——
 * 走既有的「任务 readTable + 快照」机制，发票中心按店铺汇总展示。
 *
 * 红线（与其他平台适配层一致）：**锚点必须实测**。这里登记的每条都写清了实测日期与实测到的表结构。
 * 未实测的平台/页面不要登记假锚点——界面会如实说明"该平台暂无可读取的发票页"，而不是拿猜的选择器去试。
 *
 * 实测记录（2026-09-14，真实登录态店铺）：
 *  - 微信小店：/shop/bill/home「发票中心」；页签「可开票 / 已开票 / 开票记录」；
 *    汇总「可开票 ¥41.50 / 已开票 ¥0.00」；数据表表头 = 账单号 | 账单日期 | 账单类型 | 可开金额 | 账单信息
 *  - 拼多多：/invoice/center「订单开票」；表头 = 订单号 | 订单状态 | 售后状态 | 申请时间 | 发票金额 |
 *    开票方式 | 发票种类 | 发票类型 | 抬头类型 | 发票抬头 | 企业税号 | 其他信息 | 发票邮寄地址 | 承诺开票时间 | 操作
 *  - 抖店：/ffa/m-invoice/merchant-invoice「我给平台开票」；表头 = 账单名称 | 账单类型 | 收票方主体 | 账单总额
 *  - 快手小店：**未找到可读取的发票页**（后台整页无「发票」入口，资金类路径均重定向回后台首页）→ 不登记
 */

/** 发票中心统一展示的列（各平台能提供的字段映射到这些列；缺失的显示"—"） */
export const INVOICE_COLUMNS = [
  { key: 'id', label: '单号/账单号' },
  { key: 'period', label: '期间/申请时间' },
  { key: 'type', label: '类型' },
  { key: 'amount', label: '可开金额' },
  { key: 'title', label: '发票抬头/收票方' },
  { key: 'taxNo', label: '税号' },
  { key: 'status', label: '状态' },
  { key: 'deadline', label: '承诺/到期' }
] as const

export type InvoiceColumnKey = (typeof INVOICE_COLUMNS)[number]['key']

/**
 * 一个「开票方向」（页签）= 一套表头映射。
 *
 * 为什么要分方向：实测同一发票页上「给平台开票 / 给买家开票 / 申请平台开票」是**不同的数据**——
 * 微信小店实测：「申请平台开票」5 条（账单号*+技术服务费），而「给平台开票」另有 2 条
 * （账单号 B*、用户补贴、待处理）。只抓默认页签会漏掉另一个方向的全部记录。
 */
export interface InvoiceSection {
  /** 方向名（平台自己的叫法，界面直接显示；如「给平台开票」） */
  name: string
  /**
   * 抓该方向前要点的页签文案。**为空 = 页面默认就停在这个方向**（实测微信默认在「申请平台开票」）。
   * 注意：页面上可能有同名非页签元素（实测微信有个y≈167 的 DIV），所以点击走 JS 逐级 click
   * （见 invoice-steps.ts 的注释），而不是按文案坐标点。
   */
  tabText?: string
  /**
   * 页签点击的**查找范围**限定（`clickByText.within`）。
   * 实测动机：页签文案在页面上常有同名副本（教程文案、标题），限定到页签容器里点才准。
   */
  tabWithin?: { selector: string; climb?: number }
  /**
   * 点完校验页签**真的选中了**（`clickByText.verifyActive`）。
   *
   * 为什么必须有：平台常有一批**表头完全相同**的页签（实测快手发票页「处理中」与
   * 「处理记录」列名一致）。切页签静默失败时读回的是上一个页签的数据，而按表头做的
   * `expectHeaders`/`rejectHeaders` 对这种情况完全看不出来——校验选中态才拦得住。
   */
  tabVerify?: { selector: string; classIncludes: string }
  /**
   * 该方向的页**不在**平台的默认发票页上，而在另一个地址（实测拼多多：
   * 「给平台开票」在资金中心 cashier.pinduoduo.com/main/invoice，而「给买家开票」在
   * mms.pinduoduo.com/invoice/center，两者是不同站点）。给了它就先导航过去再读。
   */
  pageUrl?: string
  /**
   * 非表格方向：该方向的信息以"标签 + 邻近文本"成对呈现，而不是一张表（实测拼多多资金中心
   * 「提交发票」页：待开票金额（元） 421.40 / 收票主体 上海寻梦信息技术有限公司 /
   * 账单日期 2026年05/06/07/08月）。给了它就逐个标签读值，拼成该方向的**一行**。
   */
  labels?: { label: string; key: InvoiceColumnKey }[]
  /** 该方向数据表的表头特征（表内须含该文案），用于多张表中挑对一张。labels 模式不需要 */
  pickByHeader?: string
  /** 表头与数据分属两个 <table>（实测拼多多：table[0] 只有表头行）→ 读表时把下一张一并合并 */
  mergeHeaderTable?: boolean
  /**
   * 读到含这些列名的表就**不采信**，按"该方向没数据"处理。
   *
   * 为什么需要它：切页签失败时，页面上留着的还是**上一个方向**的表。若该方向恰好没有自己的表
   * （实测微信「给买家开票」整页无表），这一步就会把上一个方向的数据当成它的上报——
   * 界面里出现两份一模一样、却挂着不同方向名的记录，是最危险的静默错误。
   * 而微信「给平台开票」的表头带「处理状态」（其他方向都没有），正好可以当判据。
   * 与 emptyOk 配套用：命中 rejectHeaders 只是"这不是我的表"，不是报错。
   */
  rejectHeaders?: string[]
  /** 表头文案 → 统一列 key（实测的表头文案） */
  headerMap: Record<string, InvoiceColumnKey>
  /** 该方向的快照指标名前缀（实际落库为 `<metricPrefix>.<序号>`，一个方向一条，互不覆盖） */
  metricKey: string
  /** 该方向实测到的条数（写档案里，便于日后对比"是不是抓漏了"） */
  measuredRows: number
  /**
   * 该方向是否还有**商家侧待办**。默认 true。
   *
   * 为什么要这个标记：同一页的某些方向是**已提交/已办完**的流水，商家这边没有待办动作
   * （实测快手发票页：「处理中」= 已提交等平台审核、「处理记录」= 已审核通过）。
   * 把它们算进"待开票条数/可开金额合计"，合计就虚高了——界面必须只对真正待办的求和，
   * 这类方向照常展示、但单独标注且不计入。
   */
  pending?: boolean
  /**
   * `pending: false` 时展示给用户的**原因**（如实写清这一页是什么状态）。
   * 不写就用界面的通用兜底文案。
   */
  notPendingNote?: string
}

/**
 * 一个平台的发票页档案（**可含多个开票方向**）。
 * 抓取做法：navigate → waitForPage → 逐个方向（切页签 → readTable 读整表落快照）。
 * 表头映射用**列名文案**（平台改版时列名通常会保留，比 CSS 哈希稳），映射不到的列进 extras。
 */
export interface InvoiceProfile {
  platform: string
  /** 发票页地址（实测） */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 数据表选择器 */
  tableSelector: string
  /** 整页在 ShadowRoot 内需要穿透（微信小店） */
  deep?: boolean
  /** 读表前额外等待（页面异步取数） */
  settleMs?: number
  /** 切方向后额外等待（页内重渲染 + 重新取数） */
  tabSettleMs?: number
  /** 实测日期 */
  measuredAt: string
  /** 该平台有哪些开票方向（实测） */
  sections: InvoiceSection[]
  /** 界面备注（口径/边界，如实写） */
  note?: string
}

const WEIXIN: InvoiceProfile = {
  platform: '微信小店',
  pageUrl: 'https://store.weixin.qq.com/shop/bill/home',
  urlMarker: 'bill/home',
  // 实测该页有多张 table（两张是日历），数据表以表头含「账单号」区分；
  // deep：整页在 micro-app 的 ShadowRoot 内
  tableSelector: 'table',
  deep: true,
  // 实测：页面加载后**默认就停在「申请平台开票」**（该页签选中、数据表已在），故该方向 tabText 留空。
  settleMs: 8000,
  // 切方向后要等页内重渲染 + 重新取数（实测 10s 内稳定）
  tabSettleMs: 10000,
  measuredAt: '2026-09-14',
  sections: [
    {
      name: '申请平台开票',
      // 默认方向，不需要点击
      pickByHeader: '账单号',
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount' },
      metricKey: 'invoice.applyPlatform',
      measuredRows: 5
    },
    {
      name: '给平台开票',
      tabText: '给平台开票',
      pickByHeader: '账单号',
      // 该方向多出「处理状态」「操作」两列（实测），状态映射到 status
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount', 处理状态: 'status' },
      metricKey: 'invoice.toPlatform',
      measuredRows: 2
    },
    {
      name: '给买家开票',
      tabText: '给买家开票',
      pickByHeader: '账单号',
      headerMap: { 账单号: 'id', 账单日期: 'period', 账单类型: 'type', 可开金额: 'amount' },
      metricKey: 'invoice.toBuyer',
      // 实测该方向下没有账单列表（表都没有）→ 0 条；仍保留方向，抓到就展示、抓不到如实标 0
      measuredRows: 0,
      // 「给买家开票」自己没有表，而它的前一个方向「给平台开票」的表头带「处理状态」——
      // 切页签若没生效就会把那张表读成本方向的数据（方向名不同、内容却完全一样）。
      // 用这个列名把那种情况挡掉：识别为"不是本方向的表"，落 0 条。
      rejectHeaders: ['处理状态']
    }
  ],
  note: '三个方向各自独立取数（实测「申请平台开票」与「给平台开票」数据不同）：申请平台开票 / 给平台开票 / 给买家开票。'
}

const PINDUODUO: InvoiceProfile = {
  platform: '拼多多',
  pageUrl: 'https://mms.pinduoduo.com/invoice/center',
  urlMarker: 'invoice/center',
  tableSelector: 'table',
  settleMs: 7000,
  tabSettleMs: 8000,
  measuredAt: '2026-09-14',
  sections: [
    {
      // 拼多多的「订单开票」就是买家向商家申请开票 → 即「给买家开票」
      name: '给买家开票（订单开票）',
      pickByHeader: '订单号',
      mergeHeaderTable: true,
      headerMap: {
        订单号: 'id',
        申请时间: 'period',
        发票类型: 'type',
        发票金额: 'amount',
        发票抬头: 'title',
        企业税号: 'taxNo',
        订单状态: 'status',
        承诺开票时间: 'deadline'
      },
      metricKey: 'invoice.toBuyer',
      measuredRows: 3
    },
    {
      // 「给平台开票」在**资金中心**（另一个站点），不在本页——实测 2026-09-14：
      // https://cashier.pinduoduo.com/main/invoice 的「提交发票」页给出待开票金额与收票主体。
      // 该页是"标签 + 邻近文本"的卡片，不是表格 → 用 labels 模式读。
      name: '给平台开票（资金中心）',
      pageUrl: 'https://mms.pinduoduo.com/cashier/finance/invoice',
      // 该页默认停在「申请发票」（只有说明文字，没有数据），要切到「提交发票」才有待开票金额
      tabText: '提交发票',
      labels: [
        // 实测文案（含全角括号），必须原样写才匹配得上
        { label: '账单日期', key: 'period' },
        { label: '待开票金额（元）', key: 'amount' },
        { label: '收票主体', key: 'title' }
      ],
      headerMap: {},
      metricKey: 'invoice.toPlatform',
      measuredRows: 1
    }
  ],
  note: '「订单开票」即买家向商家发起的开票申请（给买家开票）：订单号 / 申请时间 / 发票金额 / 发票抬头 / 企业税号 / 订单状态 / 承诺开票时间（含逾期天数）。「给平台开票」在资金中心（另一个站点），页面上是卡片不是表格，取的是账单日期 / 待开票金额 / 收票主体。'
}

const DOUDIAN: InvoiceProfile = {
  platform: '抖店',
  pageUrl: 'https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice',
  urlMarker: 'merchant-invoice',
  tableSelector: 'table',
  settleMs: 8000,
  tabSettleMs: 10000,
  measuredAt: '2026-09-14',
  // 实测（2026-09-14 真机）：该页有**四个**方向，不是两个——
  //   我给平台开票（默认，1 条）/ 给消费者开票 / 平台给我开票（38 行）/ 达人给我开票（无表）
  // 前两个回应"给平台开票 / 给买家开票"的诉求；后两个是页面本来就有的方向，一并如实采集。
  sections: [
    {
      // 页面默认停在「我给平台开票」
      name: '我给平台开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 收票方主体: 'title', 账单总额: 'amount' },
      metricKey: 'invoice.toPlatform',
      measuredRows: 1,
      // 同页还有个「平台给我开票」，表头只差一个字（收票方主体 / 开票方主体）——
      // 切页签没生效时用它挡住，避免两个方向显示成同一批数据
      rejectHeaders: ['开票方主体']
    },
    {
      name: '给消费者开票',
      tabText: '给消费者开票',
      pickByHeader: '订单信息',
      // 实测表头（2026-09-14 真机；此前这里登记的是**猜的**拼多多式列名，已按实测改正）：
      // 订单信息 | 发票类型 | 发票抬头/税号 | 开票金额 | 申请时间 | 订单状态 | 开票状态 |
      // 最晚开票时间 | 开票完成时间 | 操作
      headerMap: {
        订单信息: 'id',
        发票类型: 'type',
        开票金额: 'amount',
        申请时间: 'period',
        订单状态: 'status',
        最晚开票时间: 'deadline',
        // 该平台把抬头与税号合成一列，统一列里没有对应项 → 映射到抬头（税号随该列一起展示在抬头里），
        // 宁可在抬头里带出税号，也不要因为"拆不开"把这一列整列丢掉
        '发票抬头/税号': 'title'
      },
      metricKey: 'invoice.toBuyer',
      // 实测该方向当前 0 条（表在、表头在，只是没有申请）
      measuredRows: 0,
      rejectHeaders: ['账单名称']
    },
    {
      // 平台开给商家的票（账单名称/账单类型/开票方主体/账单金额）——实测 38 行，同一页的第三个方向
      name: '平台给我开票',
      tabText: '平台给我开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 开票方主体: 'title', 账单金额: 'amount' },
      metricKey: 'invoice.fromPlatform',
      // 实测 37 条数据行（表内 tr 共 38，含表头）
      measuredRows: 37,
      rejectHeaders: ['收票方主体']
    },
    {
      // 达人开给商家的票——实测该方向整页没有表（页面只有标题，无数据表）
      name: '达人给我开票',
      tabText: '达人给我开票',
      pickByHeader: '账单名称',
      headerMap: { 账单名称: 'id', 账单类型: 'type', 达人主体: 'title', 账单金额: 'amount' },
      metricKey: 'invoice.fromDaren',
      measuredRows: 0,
      // 该方向没表；若切页签没生效，读到的一定是邻居（含「账单名称」+「收票方主体」或「开票方主体」）
      rejectHeaders: ['收票方主体', '开票方主体', '订单信息']
    }
  ],
  note: '四个方向各自独立取数：我给平台开票（默认，待开票账单）/ 给消费者开票（给买家开票）/ 平台给我开票 / 达人给我开票。「给消费者开票」的抬头与税号在平台上是同一列，统一列里放在「发票抬头/收票方」并带出税号。'
}

const KUAISHOU: InvoiceProfile = {
  platform: '快手小店',
  // 实测路径：后台「资金」→「给平台开票」→「未开票账单」（菜单需先滚进视口才点得到）
  pageUrl: 'https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy',
  urlMarker: 'tax-bill/subsidy',
  tableSelector: 'table',
  settleMs: 9000,
  tabSettleMs: 8000,
  measuredAt: '2026-09-14',
  // 实测（2026-09-14 真机，ant-tabs 三个页签）：
  //   未开票账单（默认，5 条）/ 处理中（0 条）/ 处理记录（3 条）
  // 「处理中」与「处理记录」**表头完全相同**（流水单号/账单编号/…/状态/操作）——
  // 切页签静默失败时表头校验完全看不出来，必须靠 tabVerify 校验选中态（见该字段说明）。
  sections: [
    {
      name: '给平台开票（未开票账单）',
      pickByHeader: '账单编号',
      headerMap: {
        '账单编号': 'id',
        '账单月份': 'period',
        '账单类型': 'type',
        '账单金额（元）': 'amount',
        '开票主体名称': 'title',
        '阈值生效时间': 'deadline'
      },
      metricKey: 'invoice.toPlatform',
      measuredRows: 5
    },
    {
      name: '开票处理中',
      tabText: '处理中',
      // 页签容器限定：页面上有同名文案的标题/教程，限定到 .ant-tabs-tab-btn 里点才准
      tabWithin: { selector: '.ant-tabs-tab-btn' },
      tabVerify: { selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' },
      pickByHeader: '流水单号',
      headerMap: {
        '流水单号': 'id',
        '账单月份': 'period',
        '账单金额（元）': 'amount',
        '发票类型': 'type',
        '状态': 'status'
      },
      metricKey: 'invoice.processing',
      measuredRows: 0,
      // 已提交、等平台审核——商家这边没有待办动作，不计入"待开票"
      pending: false,
      notPendingNote: '已提交、等平台审核的流水，商家无需再操作'
    },
    {
      name: '开票处理记录',
      tabText: '处理记录',
      tabWithin: { selector: '.ant-tabs-tab-btn' },
      tabVerify: { selector: '.ant-tabs-tab', classIncludes: 'ant-tabs-tab-active' },
      pickByHeader: '流水单号',
      headerMap: {
        '流水单号': 'id',
        '账单月份': 'period',
        '账单金额（元）': 'amount',
        '发票类型': 'type',
        '状态': 'status'
      },
      metricKey: 'invoice.records',
      measuredRows: 3,
      // 实测里面是「审核通过」的流水（已办完）→ 展示但不计入待开票
      pending: false,
      notPendingNote: '已提交并通过审核的记录，商家无需再操作'
    }
  ],
  note: '取「给平台开票」三个页签：未开票账单（账单编号 / 账单月份 / 账单类型 / 账单金额（元）/ 开票主体名称 / 阈值生效时间，阈值金额与收票主体名称进「其他信息」）/ 处理中 / 处理记录（后两者是提交后的核销流水：流水单号 / 账单编号 / 账单月份 / 账单金额 / 发票类型 / 提交时间 / 状态，违约金三项与核销方式进「其他信息」）。'
}

export const INVOICE_PROFILES: Readonly<Record<string, InvoiceProfile>> = {
  [WEIXIN.platform]: WEIXIN,
  [PINDUODUO.platform]: PINDUODUO,
  [DOUDIAN.platform]: DOUDIAN,
  [KUAISHOU.platform]: KUAISHOU
}

export function invoiceProfileFor(platformName: string | null | undefined): InvoiceProfile | null {
  if (!platformName) return null
  return INVOICE_PROFILES[platformName] || null
}

/**
 * 单元格文本规范化（主进程映射时统一走这里，界面与 CSV 导出共用同一份结果）。
 *
 * 实测踩到的两种脏文本：
 *  ① 同一段文案重复两遍——平台为了响应式/自定义 tooltip 会把同内容渲染两次，
 *     cell.innerText 于是变成 "2026年01月\n\n2026年01月"（快手「处理记录」的账单月份）；
 *  ② 内部换行/多空格——拼多多的订单号带 "\n逾期未开票"，直接展示会把表格撑破。
 *
 * 规则保守：只把**连续空白**压成一个空格，并且只在"整串正好是同一段重复两遍"时才去重，
 * 绝不做模糊的相似度合并（那会把真有重复含义的内容吃掉）。
 * 每半段至少要 2 个字符才判重复——否则「人人」这种叠字内容会被误削成「人」。
 */
export function normalizeCellText(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // 整串正好由同一段重复两遍构成 → 只留一遍
  const compact = s.replace(/ /g, '')
  if (compact.length >= 4 && compact.length % 2 === 0) {
    const half = compact.slice(0, compact.length / 2)
    if (half === compact.slice(compact.length / 2)) return half
  }
  return s
}

/** 已实测可抓取待开票信息的平台（供界面如实展示） */
export const INVOICE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVOICE_PROFILES)

/**
 * 表格行清洗（注入到页面脚本里执行的**源码字符串**，见 task-runner 的 readTable）。
 *
 * 平台表格里有两类"不是数据的数据行"，直接当数据会污染发票清单：
 *  ① 重复表头行——表被拆成两张、或表头在 tbody 里重复渲染时，第一行数据位置又是表头文案
 *     （实测抖店「平台给我开票」：第一行被当成了一条"账单名称/账单类型"的记录）；
 *  ② 空态占位行——没数据时平台渲染一行「暂无数据」（实测抖店「给消费者开票」，
 *     被统计成 1 条待开票记录）。
 *
 * 判据只看文案、不看类名：整行都是空态词 → 丢；非首行且 ≥60% 单元格与表头文案相同 → 丢。
 * 写成字符串常量是为了能注入页面脚本，同时也让单测能对着**同一份实现**验证。
 */
export const TABLE_ROW_CLEAN_FN = `
  const __cleanRows = (out) => {
    const EMPTY_WORDS = /^(暂无数据|暂无信息|暂无记录|暂无|没有数据|无数据|no ?data|-|—|--)$/i;
    const headerLabels = new Set(out[0].map(x => String(x).trim()).filter(Boolean));
    return out.filter((row, idx) => {
      const vals = row.map(x => String(x).trim()).filter(Boolean);
      if (!vals.length) return false;
      if (vals.every(v => EMPTY_WORDS.test(v))) return false;
      if (idx > 0 && headerLabels.size) {
        const hit = vals.filter(v => headerLabels.has(v)).length;
        if (hit / vals.length >= 0.6) return false;
      }
      return true;
    });
  };
`

/** 已知但**未实测到可读发票页**的平台（界面如实说明，不给假锚点） */
export const INVOICE_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {}
