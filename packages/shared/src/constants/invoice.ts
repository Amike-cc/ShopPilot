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
 * 一个平台的发票页档案。
 * 抓取做法：navigate → waitForPage → （可选）点页签 → readTable 读整表 → 落快照。
 * 表头映射用**列名文案**（平台改版时列名通常会保留，比 CSS 哈希稳），映射不到的列进 extras。
 */
export interface InvoiceProfile {
  platform: string
  /** 发票页地址（实测） */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 数据表选择器（实测可稳定定位到"那一张"数据表的写法） */
  tableSelector: string
  /** 页面有多张表时，据此挑出数据表（表内需包含该文案，如实测微信的「账单号」） */
  pickByHeader: string
  /** 表头与数据分属两个 <table>（实测拼多多：table[0] 只有表头行）→ 读表时把下一张一并合并 */
  mergeHeaderTable?: boolean
  /** 整页在 ShadowRoot 内需要穿透（微信小店） */
  deep?: boolean
  /** 抓取前要先点的页签文案（如「可开票」）——不点的话默认页签可能不是待开票 */
  tabText?: string
  /** 读表前额外等待（页面异步取数） */
  settleMs?: number
  /** 表头文案 → 统一列 key 的映射（实测的表头文案） */
  headerMap: Record<string, InvoiceColumnKey>
  /** 指标名（快照落库用，一个平台一条：存整表行数组） */
  metric: string
  /** 实测日期 */
  measuredAt: string
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
  pickByHeader: '账单号',
  deep: true,
  // 实测：页面加载后**默认就停在「可开票」**（该页签为选中态、数据表已在），
  // 不需要点页签。页面顶部另有一个同名 DIV（非页签），clickByText 会命中它 —— 反而多余且易错。
  settleMs: 8000,
  headerMap: {
    账单号: 'id',
    账单日期: 'period',
    账单类型: 'type',
    可开金额: 'amount'
  },
  metric: 'invoice.rows',
  measuredAt: '2026-09-14',
  note: '取「可开票」页签：账单号 / 账单日期 / 账单类型 / 可开金额。页面另有汇总「可开票 / 已开票」总额，界面单独展示。'
}

const PINDUODUO: InvoiceProfile = {
  platform: '拼多多',
  pageUrl: 'https://mms.pinduoduo.com/invoice/center',
  urlMarker: 'invoice/center',
  tableSelector: 'table',
  pickByHeader: '订单号',
  mergeHeaderTable: true,
  settleMs: 7000,
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
  metric: 'invoice.rows',
  measuredAt: '2026-09-14',
  note: '取「订单开票」列表：订单号 / 申请时间 / 发票金额 / 发票抬头 / 企业税号 / 订单状态 / 承诺开票时间（含逾期天数）。'
}

const DOUDIAN: InvoiceProfile = {
  platform: '抖店',
  pageUrl: 'https://fxg.jinritemai.com/ffa/m-invoice/merchant-invoice',
  urlMarker: 'merchant-invoice',
  tableSelector: 'table',
  pickByHeader: '账单名称',
  settleMs: 8000,
  headerMap: {
    账单名称: 'id',
    账单类型: 'type',
    收票方主体: 'title',
    账单总额: 'amount'
  },
  metric: 'invoice.rows',
  measuredAt: '2026-09-14',
  note: '取「我给平台开票 → 待开票账单」：账单名称 / 账单类型 / 收票方主体 / 账单总额。该页另有「给消费者开票 / 平台给我开票 / 达人给我开票」页签，本版只抓默认的待开票账单。'
}

export const INVOICE_PROFILES: Readonly<Record<string, InvoiceProfile>> = {
  [WEIXIN.platform]: WEIXIN,
  [PINDUODUO.platform]: PINDUODUO,
  [DOUDIAN.platform]: DOUDIAN
}

export function invoiceProfileFor(platformName: string | null | undefined): InvoiceProfile | null {
  if (!platformName) return null
  return INVOICE_PROFILES[platformName] || null
}

/** 已实测可抓取待开票信息的平台（供界面如实展示） */
export const INVOICE_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(INVOICE_PROFILES)

/** 已知但**未实测到可读发票页**的平台（界面如实说明，不给假锚点） */
export const INVOICE_UNSUPPORTED_NOTE: Readonly<Record<string, string>> = {
  快手小店: '实测其后台整页无「发票」入口，资金类路径均重定向回后台首页——本版无法抓取，未登记假锚点。'
}
