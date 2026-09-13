/**
 * 经营指标「平台档案」（数据中心用）
 *
 * 数据从哪来：本应用没有平台官方 API，**只能从各平台后台页面读取**——走既有的
 * 「任务 readText + 指标名 → store_snapshots 快照」机制，数据中心再按店铺汇总展示。
 *
 * 红线（与其他平台适配层一致）：**锚点必须实测**，不猜。
 * 因此 BUSINESS_PROFILES 里只登记已在真实登录态店铺上实测过锚点的平台；
 * 未登记的平台，采集入口会明确说明"尚未实测"，而不是拿一个猜的选择器去试。
 *
 * 实测口径（每平台登记时写清）：
 *  - pageUrl：一次能读到尽量多指标的页面（减少导航次数）；
 *  - urlMarker：navigate 后 waitForPage 的就绪判据；
 *  - metrics：每个指标一条 readText 锚点（selector 以实测的稳定属性/结构为准）。
 */

/** 数据中心要展示的五个经营指标（key 即快照指标名，落库用） */
export const BIZ_METRICS = [
  { key: 'biz.units', label: '销量' },
  { key: 'biz.orders', label: '订单' },
  { key: 'biz.gmv', label: '销售额' },
  { key: 'biz.refundAmount', label: '退款金额' },
  { key: 'biz.refundOrders', label: '退款订单数' }
] as const

export type BizMetricKey = (typeof BIZ_METRICS)[number]['key']

export interface BizMetricAnchor {
  /** 与 BIZ_METRICS.key 对应 */
  key: BizMetricKey
  /**
   * 实测的**页面标签文案**（如「成交金额」「退款金额(退款日)」）。
   * 刻意不用 CSS 选择器：指标卡片类名普遍带构建哈希（实测快手 kpro-data、微信 weui 均如此），
   * 写死哈希会随版本失效；标签文案是平台对外的稳定表达，改版时会如实报 TASK_SELECTOR_CHANGED。
   */
  anchorText: string
  /** 标签在 ShadowRoot 内时需要穿透（微信小店整页在 shadow 里） */
  deep?: boolean
  /** 卡片文本长度上限（超过视为爬到容器层级 → 如实失败）；默认 40 */
  valueMaxLen?: number
}

export interface BusinessProfile {
  /** 平台名，与 stores.platform 一致 */
  platform: string
  /** 经营数据页 */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 实测日期（YYYY-MM-DD），供界面如实展示"哪天测的" */
  measuredAt: string
  /** 该页面能读到的指标（读不到的指标不要登记，界面会显示"未采集"） */
  metrics: BizMetricAnchor[]
  /** 额外说明（如"销量在该平台叫成交件数"） */
  note?: string
}

/**
 * 已实测的平台档案。**只登记真实登录态店铺上实测过锚点的平台**——"先猜后修"违反平台适配层红线。
 * 未登记的平台，数据中心的采集按钮会如实说明原因。
 */
const KUAISHOU: BusinessProfile = {
  platform: '快手小店',
  // 生意通 → 交易（全店成交分析 / 全店退款分析）。实测可直接导航到达，读一次覆盖多指标。
  pageUrl: 'https://syt.kwaixiaodian.com/zones/tradeManagement/dealAnalysis',
  urlMarker: 'dealAnalysis',
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额' },
    { key: 'biz.orders', anchorText: '成交订单数' },
    { key: 'biz.refundAmount', anchorText: '退款金额（支付日）' },
    { key: 'biz.refundOrders', anchorText: '退款订单数（支付日）' }
  ],
  note: '销量在本页未找到对应标签（生意通交易页只有成交金额/成交订单数/成交人数等）——留空不猜。'
}

export const BUSINESS_PROFILES: Readonly<Record<string, BusinessProfile>> = {
  [KUAISHOU.platform]: KUAISHOU
}

export function businessProfileFor(platformName: string | null | undefined): BusinessProfile | null {
  if (!platformName) return null
  return BUSINESS_PROFILES[platformName] || null
}

/** 已实测可采集经营指标的平台名（供界面如实展示） */
export const BUSINESS_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(BUSINESS_PROFILES)
