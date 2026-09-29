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
  { key: 'biz.refundOrders', label: '退款订单数' },
  { key: 'biz.adSpend', label: '投放花费' }
] as const

export type BizMetricKey = (typeof BIZ_METRICS)[number]['key']

/**
 * 页面锚点 → 统一经营指标的**显式映射**。
 *
 * 为什么不按中文文案推断：`成交订单数` 到底算 `orderCount`（下单）还是 `paidOrderCount`（支付），
 * 靠猜会把两个口径混在一个字段里。口径必须由档案显式声明，界面上再如实显示"这个数字来自哪条锚点"。
 * 声明不了（页面没有该指标）就留空 → 该字段保持 null，前端显示"未采集"。
 */
export type BizSalesField =
  | 'orderCount'
  | 'paidOrderCount'
  | 'salesQuantity'
  | 'grossSalesAmountMinor'
  | 'paidSalesAmountMinor'
  | 'refundAmountMinor'
  | 'refundOrderCount'
  | 'refundQuantity'
  | 'adSpendMinor'

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
  /** 该锚点写入哪个统一经营指标；不声明表示只给数据中心快照用，不进统一指标 */
  salesField?: BizSalesField
  /** 该锚点的原始单位是「元」还是「件/单」——决定读数后是否 ×100 存分 */
  salesUnit?: 'MINOR_CNY' | 'COUNT'
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
  /**
   * 「周期真的切过去了」的判据文案（实测：点完「近7天」后卡片上出现「较上周期 X%」，
   * 而默认的「今天」视图显示的是「昨日 X」）。
   *
   * 为什么需要它：**点到控件 ≠ 周期已生效**（2026-09-28 实测事故——微信小店那次点击没生效，
   * 采集把「今天」的 ¥0 / 0 单当成「近7天」写了库，而近7天真实值是 ¥108.90 / 11 单）。
   * 采集侧在点完之后会同时用两条判据确认：①首个指标的值真的变了，②出现这里声明的文案；
   * 两条都不成立就报 `PERIOD_NOT_APPLIED` 并且**一个字段都不写**。
   * 未声明的平台只能靠判据①（默认周期与目标周期不同时它同样有效）。
   */
  periodAppliedText?: string
  /** 周期控件在 ShadowRoot 内时需要穿透点击（微信小店整页在 shadow 里） */
  periodDeep?: boolean
  /** 点完周期后等待页面重新取数的毫秒数（默认 6000；实测快手需要 ~3-5s 刷完） */
  periodSettleMs?: number
  /** 实测日期（YYYY-MM-DD），供界面如实展示"哪天测的" */
  measuredAt: string
  /** 该页面能读到的指标（读不到的指标不要登记，界面会显示"未采集"） */
  metrics: BizMetricAnchor[]
  /**
   * 本档案固定住的统计周期对应的统一周期类型。
   *
   * 为什么必须显式写：页面默认周期各平台不同（实测快手商品总览默认"昨日"、微信首页默认"今天"），
   * 而档案里的 periodText 会把周期切成「近7日/近7天」。若自动采集把这种数据标成 TODAY，
   * 就是把 7 天的数字当成今天的——比没有数字更糟。所以这里声明一次，采集侧按它落 period_type。
   */
  salesPeriodType: 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'
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
  salesPeriodType: 'LAST_7_DAYS',
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额', salesField: 'grossSalesAmountMinor', salesUnit: 'MINOR_CNY' },
    { key: 'biz.orders', anchorText: '成交订单数', salesField: 'paidOrderCount', salesUnit: 'COUNT' },
    { key: 'biz.units', anchorText: '成交件数', salesField: 'salesQuantity', salesUnit: 'COUNT' },
    { key: 'biz.refundAmount', anchorText: '退款金额(退款日)', salesField: 'refundAmountMinor', salesUnit: 'MINOR_CNY' },
    { key: 'biz.refundOrders', anchorText: '成交退款订单数', salesField: 'refundOrderCount', salesUnit: 'COUNT' }
  ],
  note: '口径：近7日；销量取「成交件数」；退款金额取「退款金额(退款日)」、退款订单数取「成交退款订单数」。页面只给一个订单数（成交订单数），因此只写 paidOrderCount，orderCount 保持 null。'
}

const WEIXIN: BusinessProfile = {
  platform: '微信小店',
  // 后台首页的「经营数据」区（整页在 <micro-app shadowdom> 的 ShadowRoot 内 → 全部需要 deep）
  pageUrl: 'https://store.weixin.qq.com/shop/home',
  urlMarker: 'shop/home',
  // 实测首页默认口径为「今天」，统一改点「近7天」（文案是"近7天"，与快手的"近7日"不同——实测为准）
  periodText: '近7天',
  // 切到近7天后卡片出现「较上周期 X%」（今天视图显示的是「昨日 X」）——用它确认周期真的生效
  periodAppliedText: '较上周期',
  periodDeep: true,
  periodSettleMs: 6000,
  salesPeriodType: 'LAST_7_DAYS',
  measuredAt: '2026-09-13',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额', deep: true, salesField: 'grossSalesAmountMinor', salesUnit: 'MINOR_CNY' },
    { key: 'biz.orders', anchorText: '成交订单数', deep: true, salesField: 'paidOrderCount', salesUnit: 'COUNT' },
    { key: 'biz.refundAmount', anchorText: '成交退款金额', deep: true, salesField: 'refundAmountMinor', salesUnit: 'MINOR_CNY' }
  ],
  note: '口径：近7天；退款金额取「成交退款金额」。销量与退款订单数：本店「店铺数据 → 交易统计」页渲染为空（无数据/权限），未采集——不猜别的口径，这两个字段保持 null。'
}

const DOUDIAN: BusinessProfile = {
  platform: '抖店',
  // 抖店后台首页：卡片上的「成交金额」「成交订单数」「投放消耗」（今日，带"较昨日"对比）
  pageUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  urlMarker: 'mshop/homepage',
  salesPeriodType: 'TODAY',
  // 2026-09-29 真机复测（店铺 1111）：首页卡片结构与 09-13 结论不同——「成交订单数」「投放消耗」
  // 都能按标签锚点读到（卡片头 成交金额 0 / 成交订单数 0 / 支出金额 0 / 投放消耗 0，值均为今日实时）。
  measuredAt: '2026-09-29',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额', salesField: 'grossSalesAmountMinor', salesUnit: 'MINOR_CNY' },
    { key: 'biz.orders', anchorText: '成交订单数', salesField: 'paidOrderCount', salesUnit: 'COUNT' },
    // 「投放消耗」= 该店广告消耗（投放分析卡），是六项概览指标里"投放花费"的抖店口径
    { key: 'biz.adSpend', anchorText: '投放消耗', salesField: 'adSpendMinor', salesUnit: 'MINOR_CNY' }
  ],
  note: '口径：今日实时（首页卡片）。**退款金额/退款订单数故意不登记**：这两列自带的归属基准默认是「支付时间」（实测列内下拉可选项为 支付时间/退款时间），而我们 refundAmountMinor 的定义是"按退款完成时间归属"——实测 2026-09-29 点击列内下拉无法可靠切到「退款时间」（aurora 弹层的选项与关闭态标签同坐标，点了不生效），宁可留 null 也不按另一个基准填数。'
}

const PINDUODUO: BusinessProfile = {
  platform: '拼多多',
  // 商家后台首页的「经营数据」卡片行：一屏内有成交金额 / 成交订单数 / 商品访客数 / 推广花费
  pageUrl: 'https://mms.pinduoduo.com/home/',
  urlMarker: 'mms.pinduoduo.com/home',
  // 卡片主值是**实时（今日累计）**，「昨日 X」是卡片里的对照行（实测点「7日」页签只换趋势图，卡片数值不变）
  salesPeriodType: 'TODAY',
  measuredAt: '2026-09-29',
  metrics: [
    { key: 'biz.gmv', anchorText: '成交金额', salesField: 'grossSalesAmountMinor', salesUnit: 'MINOR_CNY' },
    { key: 'biz.orders', anchorText: '成交订单数', salesField: 'paidOrderCount', salesUnit: 'COUNT' },
    // 「推广花费」= 多多搜索/场景推广消耗，是六项概览指标里"投放花费"的拼多多口径（实测 2026-09-29：今日 10.03 / 昨日 48.48）
    { key: 'biz.adSpend', anchorText: '推广花费', salesField: 'adSpendMinor', salesUnit: 'MINOR_CNY' }
  ],
  note: '口径：今日实时（首页卡片主值，昨日值仅作卡片内对照，不采集）。数据中心（sycm/stores_data、sycm/evaluation）的成交金额/订单数**字体反爬**——数字用私有区码位渲染，取文本得到乱码（实测 2026-09-28），因此不登记那两页；首页卡片的数字是纯文本可读。**退款金额/退款订单数不登记**：首页只有「退款/售后」待处理单数（那是待办工单数，不是退款金额/退款订单数），售后工作台页会跳转到设置页且没有聚合退款指标（实测 2026-09-29），sycm 页字体反爬——没有可信来源就留 null。'
}

export const BUSINESS_PROFILES: Readonly<Record<string, BusinessProfile>> = {
  [KUAISHOU.platform]: KUAISHOU,
  [WEIXIN.platform]: WEIXIN,
  [DOUDIAN.platform]: DOUDIAN,
  [PINDUODUO.platform]: PINDUODUO
}

export function businessProfileFor(platformName: string | null | undefined): BusinessProfile | null {
  if (!platformName) return null
  return BUSINESS_PROFILES[platformName] || null
}

/** 已实测可采集经营指标的平台名（供界面如实展示） */
export const BUSINESS_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(BUSINESS_PROFILES)
