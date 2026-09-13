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
  /**
   * 采集前先点击该文案，统一统计口径（实测的控制项文案，如「近7日」）。
   * 不固定周期的话，各页默认周期不同（实测快手商品总览默认"昨日"为 0、交易页默认近7日有值），
   * 数字口径混乱比没有数字更糟——所以周期必须显式固定并在界面如实标注。
   */
  periodText?: string
  /** 周期控件在 ShadowRoot 内时需要穿透点击（微信小店整页在 shadow 里） */
  periodDeep?: boolean
  /** 点完周期后等待页面重新取数的毫秒数（默认 6000；实测快手需要 ~3-5s 刷完） */
  periodSettleMs?: number
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
  // 生意通 → 商品 → 商品总览：一页覆盖全部五个指标（交易页无"成交件数"，故选用本页）
  pageUrl: 'https://syt.kwaixiaodian.com/zones/goodsManagement/goods_overview',
  urlMarker: 'goods_overview',
  // 实测该页默认周期为"昨日"（多为 0）；统一点「近7日」后与交易页口径一致
  periodText: '近7日',
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额' },
    { key: 'biz.orders', anchorText: '成交订单数' },
    { key: 'biz.units', anchorText: '成交件数' },
    { key: 'biz.refundAmount', anchorText: '退款金额(退款日)' },
    { key: 'biz.refundOrders', anchorText: '成交退款订单数' }
  ],
  note: '口径：近7日；销量取「成交件数」；退款金额取「退款金额(退款日)」、退款订单数取「成交退款订单数」。'
}

const WEIXIN: BusinessProfile = {
  platform: '微信小店',
  // 后台首页的「经营数据」区（整页在 <micro-app shadowdom> 的 ShadowRoot 内 → 全部需要 deep）
  pageUrl: 'https://store.weixin.qq.com/shop/home',
  urlMarker: 'shop/home',
  // 实测首页默认口径为「今天」，统一改点「近7天」（文案是"近7天"，与快手的"近7日"不同——实测为准）
  periodText: '近7天',
  periodDeep: true,
  periodSettleMs: 6000,
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额', deep: true },
    { key: 'biz.orders', anchorText: '成交订单数', deep: true },
    { key: 'biz.refundAmount', anchorText: '成交退款金额', deep: true }
  ],
  note: '口径：近7天；退款金额取「成交退款金额」。销量与退款订单数：本店「店铺数据 → 交易统计」页渲染为空（无数据/权限），未采集——不猜别的口径。'
}

const DOUDIAN: BusinessProfile = {
  platform: '抖店',
  // 抖店后台首页：卡片上的「成交金额」（今日，带"较昨日"对比）
  pageUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  urlMarker: 'mshop/homepage',
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额' }
  ],
  note: '口径：今日成交金额（后台首页卡片）。该账号罗盘未开通，其余指标无数据页可读——销量/订单/退款金额在首页与广告文案同名（实测「销量」读到的是"销量高"这类文案），故只登记能可靠读到的这一项，不猜。'
}

export const BUSINESS_PROFILES: Readonly<Record<string, BusinessProfile>> = {
  [KUAISHOU.platform]: KUAISHOU,
  [WEIXIN.platform]: WEIXIN,
  [DOUDIAN.platform]: DOUDIAN
}

export function businessProfileFor(platformName: string | null | undefined): BusinessProfile | null {
  if (!platformName) return null
  return BUSINESS_PROFILES[platformName] || null
}

/** 已实测可采集经营指标的平台名（供界面如实展示） */
export const BUSINESS_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(BUSINESS_PROFILES)
