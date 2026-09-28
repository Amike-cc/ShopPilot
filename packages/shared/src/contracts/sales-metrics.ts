/**
 * 经营指标跨进程契约。
 *
 * 该模型只承载聚合后的经营数据，不承载订单详情、买家信息或认证数据。
 * 未经平台确认的字段必须为 null，不能用 0 伪造“暂无数据”。
 */

export const SALES_METRICS_PERIOD_TYPES = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'CUSTOM'
] as const

export type SalesMetricsPeriodType = typeof SALES_METRICS_PERIOD_TYPES[number]

/**
 * 采集状态机（开发文档 §7）。
 *
 * 一个来源只有一个口径：运行记录、计划 last_status、前端状态卡都用这一组值。
 * 旧实现只有 7 个值，导致 TIMEOUT / NETWORK_ERROR / PAGE_CHANGED / PERMISSION_DENIED /
 * CIRCUIT_OPEN 全部塌缩成 ERROR——前端无法区分"网断了"和"页面改版了"。
 */
export const SALES_METRICS_COLLECTION_STATUSES = [
  /** 该店铺还没有采集计划（正常初始化前的瞬态） */
  'NOT_CONFIGURED',
  /** 代码存在，但真实平台字段/来源尚未验证——不是系统故障，也不能当正常数据 */
  'NOT_VERIFIED',
  /** 计划就绪，等待下一个周期 */
  'READY',
  'RUNNING',
  /** 指标完整且来源通过校验 */
  'SUCCEEDED',
  /** 至少一个指标成功，其余字段没有可靠来源 */
  'PARTIAL',
  /** 需要用户在店铺浏览器内重新登录：停机等待，不无限重试 */
  'LOGIN_REQUIRED',
  /** 需要用户完成安全验证（滑块/短信/二次校验）：停机等待 */
  'VERIFY_REQUIRED',
  /** 账号权限不足：停机并提示权限问题，重试无意义 */
  'PERMISSION_DENIED',
  /** 页面或字段证据失效：暂停旧解析器，等待重新验证页面档案 */
  'PAGE_CHANGED',
  /** 页面正常但没有经营数据入口/字段（例如未开通该功能） */
  'NO_METRICS_FOUND',
  'TIMEOUT',
  'NETWORK_ERROR',
  /** 数据源未完成真实验证（拼多多反抓取字体、未验证网络响应等） */
  'DATA_SOURCE_NOT_VERIFIED',
  /** 保留上次成功值，但已超过新鲜度阈值 */
  'STALE',
  /** 连续失败达到阈值，已熔断，等待人工恢复或健康检查 */
  'CIRCUIT_OPEN',
  /** 用户主动暂停计划 */
  'DISABLED',
  /** 同一店铺已有采集在跑，本次未执行 */
  'ALREADY_RUNNING',
  /** 应用退出时仍在 RUNNING 的运行：由下次启动收敛，绝不留在 RUNNING */
  'INTERRUPTED',
  /** 兜底：未分类的内部错误 */
  'ERROR'
] as const

export type SalesMetricsCollectionStatus = typeof SALES_METRICS_COLLECTION_STATUSES[number]

/** 采集成功的终态（可写库）。 */
export const SALES_METRICS_SUCCESS_STATUSES: readonly SalesMetricsCollectionStatus[] = ['SUCCEEDED', 'PARTIAL']

/**
 * 需要用户处理的停机状态：这些状态下计划不再自动重试。
 * 重试不会改变结果——只会把日志刷满并把"需要登录"淹掉。
 */
export const SALES_METRICS_USER_ACTION_STATUSES: readonly SalesMetricsCollectionStatus[] = [
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'PERMISSION_DENIED',
  'PAGE_CHANGED'
]

/** 系统故障：按退避重试，连续失败累计到阈值后熔断。 */
export const SALES_METRICS_RETRYABLE_STATUSES: readonly SalesMetricsCollectionStatus[] = [
  'TIMEOUT',
  'NETWORK_ERROR',
  'ERROR',
  'NO_METRICS_FOUND'
]

export function isSalesMetricsSuccessStatus(status: string): boolean {
  return (SALES_METRICS_SUCCESS_STATUSES as readonly string[]).includes(status)
}

export function isSalesMetricsUserActionStatus(status: string): boolean {
  return (SALES_METRICS_USER_ACTION_STATUSES as readonly string[]).includes(status)
}

export function isSalesMetricsRetryableStatus(status: string): boolean {
  return (SALES_METRICS_RETRYABLE_STATUSES as readonly string[]).includes(status)
}

export const SALES_METRICS_SOURCE_TYPES = [
  /** 已确认的平台网络响应字段 */
  'NETWORK',
  /** 已登记的页面 DOM 字段 */
  'DOM',
  /** 平台导出文件 */
  'EXPORT',
  /** 由订单明细聚合 */
  'ORDER_AGGREGATION',
  /** 视觉识别：必须带置信度与脱敏证据路径，低置信度字段必须为 null */
  'OCR',
  /** 用户手工录入（平台用反抓取字体时） */
  'MANUAL',
  /** 仅用于测试夹具；绝不允许出现在真实运行记录里 */
  'TEST_FIXTURE',
  'NONE'
] as const

export type SalesMetricsSourceType = typeof SALES_METRICS_SOURCE_TYPES[number]

export interface SalesMetrics {
  id: string
  platform: string
  storeId: string
  periodType: SalesMetricsPeriodType
  periodStart: number
  periodEnd: number
  orderCount: number | null
  paidOrderCount: number | null
  salesQuantity: number | null
  grossSalesAmountMinor: number | null
  paidSalesAmountMinor: number | null
  refundAmountMinor: number | null
  refundOrderCount: number | null
  refundQuantity: number | null
  netSalesAmountMinor: number | null
  collectedAt: number
  sourceUpdatedAt: number | null
  /** 这次数据从哪来：NETWORK/DOM/EXPORT/ORDER_AGGREGATION/OCR/MANUAL，NONE = 无可靠来源。 */
  sourceType: SalesMetricsSourceType
  /** 产生该行的 Adapter 版本，用于"页面改版后旧解析器作废"的追溯。 */
  adapterVersion: string | null
  /** 口径版本；跨平台合计只允许在版本一致时进行。 */
  metricDefinitionVersion: string
  /** 该行数据的性质（真实 0 / 部分 / 未验证…），前端据此渲染。 */
  dataStatus: SalesMetricsDataStatus
  /** 写入该行的采集运行 ID，可回溯到脱敏证据。 */
  runId: string | null
}

export interface ProductSalesMetrics {
  id: string
  platform: string
  storeId: string
  platformProductId: string | null
  platformSkuId: string | null
  productTitle: string | null
  skuName: string | null
  imageUrl: string | null
  salesQuantity: number | null
  orderCount: number | null
  grossSalesAmountMinor: number | null
  paidSalesAmountMinor: number | null
  refundQuantity: number | null
  refundAmountMinor: number | null
  periodStart: number
  periodEnd: number
  collectedAt: number
}

export interface SalesMetricsCollectionInput {
  storeId: string
  periodType?: SalesMetricsPeriodType
  periodStart?: number
  periodEnd?: number
  timeoutMs?: number
}

/**
 * 数据新鲜度（开发文档 §10）。阈值只在这里定义一次，Main 与 Renderer 共用。
 */
export const SALES_METRICS_FRESH_MS = 10 * 60 * 1000
export const SALES_METRICS_AGING_MS = 30 * 60 * 1000

export const SALES_METRICS_FRESHNESS = [
  /** 最近成功采集 <= 10 分钟 */
  'FRESH',
  /** 10～30 分钟 */
  'AGING',
  /** 超过 30 分钟 */
  'STALE',
  /** 从未成功 */
  'UNAVAILABLE',
  /** 部分字段成功 */
  'PARTIAL',
  /** 数据源未验证 */
  'SOURCE_UNVERIFIED'
] as const

export type SalesMetricsFreshness = typeof SALES_METRICS_FRESHNESS[number]

/**
 * 前端必须区分的"这条数据是什么"（开发文档 §5）。
 *
 * 这是数据状态而不是运行状态：`0` 只有在 REAL_ZERO/REAL_VALUE 下才是"平台明确返回 0"，
 * 其余状态下 `null` 表示"没有可靠数据"，绝不能渲染成 0。
 */
export const SALES_METRICS_DATA_STATUSES = [
  /** 平台明确返回的非 0 值 */
  'REAL_VALUE',
  /** 平台明确返回的真实 0（与"未采集"完全不同） */
  'REAL_ZERO',
  /** 部分字段有值、部分为 null */
  'PARTIAL',
  /** 从未采集到任何指标 */
  'NOT_COLLECTED',
  /** 数据源未完成真实验证 */
  'SOURCE_UNVERIFIED',
  /** 本次采集失败，展示的是上一次成功值或空 */
  'COLLECTION_FAILED',
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'PERMISSION_DENIED',
  'PAGE_CHANGED',
  /** 保留的上次成功值已超过新鲜度阈值 */
  'DATA_STALE',
  'CIRCUIT_OPEN',
  'PAUSED',
  'UNKNOWN'
] as const

export type SalesMetricsDataStatus = typeof SALES_METRICS_DATA_STATUSES[number]

/**
 * 统一业务口径（开发文档 §12）。口径未知时不允许自动推断，
 * 因此这里把每个字段的定义写成常量，落库时带版本号。
 */
export const SALES_METRICS_METRIC_DEFINITION_VERSION = 'sales-metrics-1'

export interface SalesMetricsFieldDefinition {
  field: keyof SalesMetrics
  label: string
  unit: 'COUNT' | 'MINOR_CNY' | 'TIMESTAMP'
  definition: string
  /** 口径未知时该字段必须为 null，而不是 0 */
  nullable: true
}

export const SALES_METRICS_METRIC_DEFINITIONS: Readonly<Record<string, SalesMetricsFieldDefinition>> = Object.freeze({
  orderCount: { field: 'orderCount', label: '下单订单数', unit: 'COUNT', definition: '统计周期内成功创建的订单数（含未付款，不含已取消），按平台口径原值记录', nullable: true },
  paidOrderCount: { field: 'paidOrderCount', label: '支付订单数', unit: 'COUNT', definition: '统计周期内买家完成支付的订单数，按支付时间归属', nullable: true },
  salesQuantity: { field: 'salesQuantity', label: '销量', unit: 'COUNT', definition: '统计周期内售出的商品件数（不含退款件数扣减，扣减见 refundQuantity）', nullable: true },
  grossSalesAmountMinor: { field: 'grossSalesAmountMinor', label: '成交金额（毛）', unit: 'MINOR_CNY', definition: '买家实付金额合计，含平台补贴后向商家结算的部分；不含运费与平台佣金', nullable: true },
  paidSalesAmountMinor: { field: 'paidSalesAmountMinor', label: '支付金额', unit: 'MINOR_CNY', definition: '已支付订单的实付金额合计，口径与 grossSalesAmountMinor 相同', nullable: true },
  refundAmountMinor: { field: 'refundAmountMinor', label: '退款金额', unit: 'MINOR_CNY', definition: '退款成功的金额合计，按退款完成时间归属（不是申请时间）', nullable: true },
  refundOrderCount: { field: 'refundOrderCount', label: '退款订单数', unit: 'COUNT', definition: '发生退款成功的订单数，按退款完成时间归属', nullable: true },
  refundQuantity: { field: 'refundQuantity', label: '退款件数', unit: 'COUNT', definition: '退款成功的商品件数', nullable: true },
  netSalesAmountMinor: { field: 'netSalesAmountMinor', label: '净销售额', unit: 'MINOR_CNY', definition: 'grossSalesAmountMinor - refundAmountMinor；只要有一个算子为 null，本字段必须为 null', nullable: true }
})

export const SALES_METRICS_PERIOD_SEMANTICS =
  '周期为左闭右闭区间 [periodStart, periodEnd]；时区统一 Asia/Shanghai；跨平台合计只允许在 metricDefinitionVersion 一致时进行。'

export interface SalesMetricsEvidenceField {
  field: string
  present: boolean
  sourceType: SalesMetricsSourceType
  confidence: number | null
}

/** Adapter 自检：证据是否足以支撑本次结果。不通过就不允许把结果当成功写库。 */
export interface SalesMetricsEvidenceCheck {
  ok: boolean
  reasonCode: string
  safeMessage: string
  fields: SalesMetricsEvidenceField[]
}

export interface SalesMetricsCollectionResult {
  storeId: string
  platform: string
  status: SalesMetricsCollectionStatus
  startedAt: number
  finishedAt: number
  periodStart: number | null
  periodEnd: number | null
  storeMetricsCount: number
  productMetricsCount: number
  inserted: number
  updated: number
  skipped: number
  failed: number
  sourceType: SalesMetricsSourceType
  reasonCode: string
  safeMessage: string
  /** 产生数据的 Adapter 版本；未执行到 Adapter 时为 null。 */
  adapterVersion: string | null
  metricDefinitionVersion: string
  /** 平台页面自己标注的数据更新时间；无法确认时必须为 null。 */
  sourceUpdatedAt: number | null
  dataStatus: SalesMetricsDataStatus
  evidence: SalesMetricsEvidenceCheck | null
}

/** 单个店铺的采集计划视图（IPC `salesMetrics:plan:list` 的条目）。 */
export interface SalesMetricsPlanView {
  storeId: string
  storeName: string
  platform: string
  enabled: boolean
  intervalMs: number
  timezone: string
  nextRunAt: number | null
  lastStartedAt: number | null
  lastSuccessAt: number | null
  lastStatus: SalesMetricsCollectionStatus | null
  lastReasonCode: string | null
  lastSafeMessage: string | null
  consecutiveFailures: number
  backoffUntil: number | null
  circuitOpen: boolean
  requiresUserAction: boolean
  freshness: SalesMetricsFreshness
  dataStatus: SalesMetricsDataStatus
  adapterVersion: string | null
  metricDefinitionVersion: string
  /** 最近一次成功采集写入的统一指标；从未成功时为 null。 */
  metrics: SalesMetrics | null
  sourceType: SalesMetricsSourceType
  sourceUpdatedAt: number | null
  collectedAt: number | null
  lastRun: SalesMetricsRunView | null
  /** 最近 24 小时趋势（只含采集成功那一刻写的聚合快照，失败不留点、不造 0）。 */
  trend: SalesMetricsTrendPoint[]
}

export interface SalesMetricsRunView {
  runId: string
  storeId: string
  platform: string
  plannedAt: number
  startedAt: number | null
  finishedAt: number | null
  status: SalesMetricsCollectionStatus
  reasonCode: string | null
  safeMessage: string | null
  retryCount: number
  durationMs: number | null
  adapterVersion: string | null
  sourceType: SalesMetricsSourceType | null
  inserted: number
  updated: number
}

export interface SalesMetricsRunQuery {
  storeId?: string
  platform?: string
  status?: SalesMetricsCollectionStatus
  page?: number
  pageSize?: number
}

export interface SalesMetricsRunListResult {
  page: number
  pageSize: number
  total: number
  items: SalesMetricsRunView[]
}

/** 最近 24 小时趋势点：只取采集成功那一刻的指标快照。 */
export interface SalesMetricsTrendPoint {
  collectedAt: number
  status: SalesMetricsCollectionStatus
  paidSalesAmountMinor: number | null
  paidOrderCount: number | null
  refundAmountMinor: number | null
}

export interface SalesMetricsHealthCounters {
  total: number
  enabled: number
  paused: number
  running: number
  fresh: number
  aging: number
  stale: number
  unavailable: number
  sourceUnverified: number
  requiresUserAction: number
  circuitOpen: number
  failuresLast24h: number
  successesLast24h: number
}

export interface SalesMetricsHealth {
  computedAt: number
  counters: SalesMetricsHealthCounters
  /** 需要用户处理的状态集合，前端按平台分组展示"打开平台页面重新登录"。 */
  attention: Array<{
    storeId: string
    storeName: string
    platform: string
    status: SalesMetricsCollectionStatus
    reasonCode: string | null
    safeMessage: string | null
    since: number | null
  }>
  nextRunAt: number | null
  lastSuccessAt: number | null
}

export interface SalesMetricsPlanListResult {
  computedAt: number
  items: SalesMetricsPlanView[]
  health: SalesMetricsHealth
}

export interface SalesMetricsPlanUpdateInput {
  storeId: string
  enabled?: boolean
  /** 允许 1 分钟～24 小时；默认 10 分钟 */
  intervalMs?: number
}

export interface SalesMetricsQuery {
  storeId: string
  periodType?: SalesMetricsPeriodType
  periodStart?: number
  periodEnd?: number
  page?: number
  pageSize?: number
}

export interface SalesMetricsProductQuery extends SalesMetricsQuery {
  sort?: 'salesQuantity' | 'paidSalesAmountMinor'
  limit?: number
}

export interface SalesMetricsListResult {
  storeId: string
  page: number
  pageSize: number
  total: number
  items: SalesMetrics[]
}

export interface ProductSalesMetricsListResult {
  storeId: string
  page: number
  pageSize: number
  total: number
  items: ProductSalesMetrics[]
}

export interface SalesMetricsObservationSummary {
  responseCount: number
  jsonResponseCount: number
  salesMetricsCandidateCount: number
  productSalesCandidateCount: number
  trendCandidateCount: number
  candidates: Array<{
    urlPattern: string
    candidateType: 'ORDER' | 'SALES_METRICS' | 'PRODUCT_SALES' | 'TREND' | 'UNKNOWN'
    confidence: 'low' | 'medium' | 'high'
    topLevelKeys: string[]
    nestedKeys: string[]
  }>
}

export const SALES_METRICS_CAPABILITY = 'salesMetrics' as const
export const PRODUCT_SALES_METRICS_CAPABILITY = 'productSalesMetrics' as const

