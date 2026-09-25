/**
 * 「订单明细」平台档案（逐条订单列表采集用）。
 *
 * 数据从哪来：没有平台官方 API，只能从各平台后台的**订单列表页**整表读取
 * （readTable + keepRows → 任务结果按行留存），再由数据中心/明细视图按列映射展示。
 *
 * 红线（与其他平台适配层一致）：**锚点必须实测**。这里只登记真实登录态下实测过
 * 页面地址、就绪判据、表格锚点与表头列名的平台；未实测的平台不登记假锚点——
 * 采集入口会如实说明"该平台尚未实测订单页"，而不是拿猜的选择器去试。
 *
 * 实测记录：（尚无平台完成订单页实测；测量口径见 docs/AGENT_PROGRESS.md）
 *  - 抖店：待测（订单页 URL 与表头列名）
 *  - 快手小店：待测
 *  - 微信小店：待测
 */

/** 明细统一展示列（各平台能提供的字段映射到这些列；缺失显示"—"） */
export const ORDER_COLUMNS = [
  { key: 'orderNo', label: '订单号' },
  { key: 'status', label: '订单状态' },
  { key: 'amount', label: '实付金额' },
  { key: 'createdAt', label: '下单时间' },
  { key: 'product', label: '商品' },
  { key: 'buyer', label: '买家' }
] as const

export type OrderColumnKey = (typeof ORDER_COLUMNS)[number]['key']

export interface OrdersProfile {
  /** 平台名，与 stores.platform 一致 */
  platform: string
  /** 订单列表页地址 */
  pageUrl: string
  /** waitForPage 就绪判据（URL 片段） */
  urlMarker: string
  /** 采集前统一周期口径的控件文案（如「近7天」）；不填 = 页面默认周期 */
  periodText?: string
  /** 周期控件在 ShadowRoot 内时需要穿透 */
  periodDeep?: boolean
  /** 点完周期后等待重新取数的毫秒数（默认 6000） */
  periodSettleMs?: number
  /** 实测日期（YYYY-MM-DD），界面如实展示"哪天测的" */
  measuredAt: string
  /** 订单明细表：整表读取（keepRows），按表头校验方向 */
  table: {
    /** 页面上有多张表时，挑表内含该文案的那一张 */
    pickByHeader?: string
    /** 表头必须包含这些列名，否则如实失败（页面改版/方向不对） */
    expectHeaders: string[]
    /** 表格 CSS 选择器（实测的稳定锚点） */
    selector: string
    /** 整页在 ShadowRoot 内时需要穿透（微信小店） */
    deep?: boolean
  }
  /** 平台列 → 统一列（key 为 ORDER_COLUMNS.key，header 为实测列名） */
  columns: Array<{ key: OrderColumnKey; header: string }>
  /** 额外说明（如"金额为实付、不含运费"） */
  note?: string
}

/**
 * 已实测的平台档案。**只登记真实登录态店铺上实测过锚点的平台**——"先猜后修"违反平台适配层红线。
 * 当前为空：订单页实测需要真实登录态（见 AGENT_PROGRESS 的测量清单）。
 */
export const ORDERS_PROFILES: Readonly<Record<string, OrdersProfile>> = {}

/** 平台档案查询；支持调用方传入实测覆盖（设置里的 `orders.profiles`，便于实测后即时登记）。 */
export function ordersProfileFor(platform: string, overrides?: Record<string, OrdersProfile> | null): OrdersProfile | null {
  const direct = (overrides && overrides[platform]) || ORDERS_PROFILES[platform]
  if (!direct) return null
  if (!direct.pageUrl || !direct.urlMarker || !direct.table?.selector || !Array.isArray(direct.table?.expectHeaders)) return null
  return direct
}
