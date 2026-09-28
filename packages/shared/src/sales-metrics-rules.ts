/**
 * 经营采集的纯规则层（开发文档 §7/§8/§10/§12）。
 *
 * 这里只放**无副作用、可单测**的判定：状态归类、退避窗口、新鲜度、数据状态、净销售额口径、
 * 跨平台合计门禁。Main 的调度器与渲染层的状态卡都读同一份规则，避免"两处各算一遍、
 * 算出来的东西不一样"——那正是"真实 0 被显示成未采集"这类问题的成因。
 */

import {
  SALES_METRICS_AGING_MS,
  SALES_METRICS_COLLECTION_STATUSES,
  SALES_METRICS_DATA_STATUSES,
  SALES_METRICS_FRESH_MS,
  SALES_METRICS_METRIC_DEFINITION_VERSION,
  isSalesMetricsRetryableStatus,
  isSalesMetricsSuccessStatus,
  isSalesMetricsUserActionStatus,
  type SalesMetrics,
  type SalesMetricsCollectionStatus,
  type SalesMetricsDataStatus,
  type SalesMetricsFreshness,
  type SalesMetricsPeriodType
} from './contracts/sales-metrics'

/** 默认采集周期：10 分钟。 */
export const SALES_METRICS_DEFAULT_INTERVAL_MS = 10 * 60 * 1000
/** 口径版本从契约层转出：调用方（Main/单测）只需引规则层这一个入口。 */
export { SALES_METRICS_METRIC_DEFINITION_VERSION }/** 周期允许范围：1 分钟～24 小时（防止用户改出"每秒一次"或"一周一次"）。 */
export const SALES_METRICS_MIN_INTERVAL_MS = 60 * 1000
export const SALES_METRICS_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 全局最大并发：同一时刻最多 2 家店铺在跑。 */
export const SALES_METRICS_MAX_PARALLEL = 2

/** 抖动窗口：四个平台错开 10～60 秒，避免同秒打满同一个平台。 */
export const SALES_METRICS_JITTER_MIN_MS = 10 * 1000
export const SALES_METRICS_JITTER_MAX_MS = 60 * 1000

/**
 * 失败退避（§8）：
 *   第 1 次失败 → 2 分钟
 *   第 2 次失败 → 5 分钟
 *   第 3 次及以后 → 60 分钟
 * 数组第 0 项是"没有失败"的占位，索引即连续失败次数。
 */
export const SALES_METRICS_BACKOFF_MS: readonly number[] = [0, 2 * 60 * 1000, 5 * 60 * 1000, 60 * 60 * 1000]

/** 连续失败达到该值即熔断（CIRCUIT_OPEN），不再自动重试。 */
export const SALES_METRICS_CIRCUIT_FAILURE_THRESHOLD = 5

const STATUS_SET = new Set<string>(SALES_METRICS_COLLECTION_STATUSES)
const DATA_STATUS_SET = new Set<string>(SALES_METRICS_DATA_STATUSES)

export function isKnownCollectionStatus(value: unknown): value is SalesMetricsCollectionStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

export function isKnownDataStatus(value: unknown): value is SalesMetricsDataStatus {
  return typeof value === 'string' && DATA_STATUS_SET.has(value)
}

export function normalizeCollectionStatus(value: unknown): SalesMetricsCollectionStatus | null {
  return isKnownCollectionStatus(value) ? value : null
}

/** 该状态对应的退避毫秒数（0 = 不按退避，直接等下一个正常周期）。 */
export function backoffMsForFailures(consecutiveFailures: number): number {
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0))
  if (failures <= 0) return 0
  return SALES_METRICS_BACKOFF_MS[Math.min(failures, SALES_METRICS_BACKOFF_MS.length - 1)]
}

/**
 * 一次运行结束后计划该怎么走。
 *
 * 返回 nextRunAtIsNull=true 表示"停机等待用户"，此时计划不自动重试；
 * 用户恢复（resume）或登录成功后的第一次成功采集会把它拉回正常周期。
 */
export interface SalesMetricsPlanTransition {
  /** 是否累计为系统故障（决定 consecutive_failures 与熔断） */
  countsAsFailure: boolean
  /** 是否要求用户处理（登录/验证/权限/页面改版） */
  requiresUserAction: boolean
  /** 是否熔断 */
  circuitOpen: boolean
  /** 下一次自动运行时间；null = 停机等待用户 */
  nextRunAt: number | null
  /** 退避截止时间（仅用于展示"退避到几点"）；null = 无退避 */
  backoffUntil: number | null
}

export function planTransition(input: {
  status: SalesMetricsCollectionStatus
  previousFailures: number
  now: number
  intervalMs: number
  jitterMs?: number
  /** 中断（应用退出）不属于故障，按正常周期续跑 */
  interrupted?: boolean
}): SalesMetricsPlanTransition {
  const intervalMs = Math.max(SALES_METRICS_MIN_INTERVAL_MS, Math.floor(Number(input.intervalMs) || SALES_METRICS_DEFAULT_INTERVAL_MS))
  const jitterMs = Math.max(0, Math.floor(Number(input.jitterMs) || 0))
  const normal = input.now + intervalMs + jitterMs

  if (input.interrupted) {
    return { countsAsFailure: false, requiresUserAction: false, circuitOpen: false, nextRunAt: normal, backoffUntil: null }
  }
  if (isSalesMetricsSuccessStatus(input.status)) {
    return { countsAsFailure: false, requiresUserAction: false, circuitOpen: false, nextRunAt: normal, backoffUntil: null }
  }
  if (input.status === 'DATA_SOURCE_NOT_VERIFIED' || input.status === 'NOT_VERIFIED' || input.status === 'NOT_CONFIGURED') {
    // 数据源未验证不是系统故障：不能显示正常数据，但也不该进熔断堆积。
    return { countsAsFailure: false, requiresUserAction: false, circuitOpen: false, nextRunAt: normal, backoffUntil: null }
  }
  if (input.status === 'DISABLED' || input.status === 'ALREADY_RUNNING') {
    return { countsAsFailure: false, requiresUserAction: false, circuitOpen: false, nextRunAt: input.status === 'DISABLED' ? null : normal, backoffUntil: null }
  }
  if (isSalesMetricsUserActionStatus(input.status)) {
    // 登录失效/验证/权限/页面改版：停机等待，重试不会改变结果。
    return { countsAsFailure: false, requiresUserAction: true, circuitOpen: false, nextRunAt: null, backoffUntil: null }
  }
  const failures = Math.max(0, Math.floor(Number(input.previousFailures) || 0)) + 1
  const circuitOpen = failures >= SALES_METRICS_CIRCUIT_FAILURE_THRESHOLD
  const backoff = backoffMsForFailures(failures)
  return {
    countsAsFailure: true,
    requiresUserAction: false,
    circuitOpen,
    // 熔断后停机等待人工恢复；否则取「正常周期」与「退避窗口」的较大者——
    // 旧实现把 next_run_at 固定成 now+interval，60 分钟的退避被 10 分钟周期吃掉。
    nextRunAt: circuitOpen ? null : Math.max(normal, input.now + backoff),
    backoffUntil: backoff > 0 ? input.now + backoff : null
  }
}

/**
 * 新鲜度（§10）。`lastSuccessAt` 必须来自**最近一次真正成功**的采集，
 * 失败不刷新它——否则"采集一直失败但状态显示新鲜"会误导用户。
 */
export function computeFreshness(input: {
  lastSuccessAt: number | null
  lastStatus: SalesMetricsCollectionStatus | null
  now: number
}): SalesMetricsFreshness {
  const status = input.lastStatus
  if (status === 'DATA_SOURCE_NOT_VERIFIED' || status === 'NOT_VERIFIED' || status === 'NOT_CONFIGURED') return 'SOURCE_UNVERIFIED'
  const lastSuccessAt = Number(input.lastSuccessAt)
  if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return 'UNAVAILABLE'
  const age = Math.max(0, input.now - lastSuccessAt)
  if (age <= SALES_METRICS_FRESH_MS) return 'FRESH'
  if (age <= SALES_METRICS_AGING_MS) return 'AGING'
  return 'STALE'
}

/** 把「运行状态 + 是否有快照 + 新鲜度」映射成前端要区分的数据状态。 */
export function deriveDataStatus(input: {
  lastStatus: SalesMetricsCollectionStatus | null
  freshness: SalesMetricsFreshness
  hasMetrics: boolean
  intervalMs: number
  now: number
  lastSuccessAt: number | null
}): SalesMetricsDataStatus {
  const status = input.lastStatus
  if (status === 'DISABLED') return 'PAUSED'
  if (status === 'CIRCUIT_OPEN') return 'CIRCUIT_OPEN'
  if (status === 'LOGIN_REQUIRED') return 'LOGIN_REQUIRED'
  if (status === 'VERIFY_REQUIRED') return 'VERIFY_REQUIRED'
  if (status === 'PERMISSION_DENIED') return 'PERMISSION_DENIED'
  if (status === 'PAGE_CHANGED') return 'PAGE_CHANGED'
  if (status === 'DATA_SOURCE_NOT_VERIFIED' || status === 'NOT_VERIFIED' || status === 'NOT_CONFIGURED') return 'SOURCE_UNVERIFIED'
  if (status === 'PARTIAL') return 'PARTIAL'
  // 成功过的快照超过新鲜度阈值 → 数据过期（保留上次成功值，但要标明它旧了）
  if (input.hasMetrics && input.freshness === 'STALE') return 'DATA_STALE'
  if (status === 'SUCCEEDED' && input.hasMetrics) return 'REAL_VALUE'
  // SUCCEEDED 但没有快照行是自相矛盾的，只能当"没采到"：这里绝不返回 REAL_ZERO——
  // "真实 0"的判定属于行级（deriveRowDataStatus 逐字段看平台是否明确返回 0）。
  if (status === 'SUCCEEDED') return 'NOT_COLLECTED'
  if (input.hasMetrics) return input.freshness === 'STALE' ? 'DATA_STALE' : 'REAL_VALUE'
  if (status && isSalesMetricsRetryableStatus(status)) return 'COLLECTION_FAILED'
  if (status === 'RUNNING' || status === 'READY' || status === 'ALREADY_RUNNING' || status === null) return 'NOT_COLLECTED'
  return 'UNKNOWN'
}

/**
 * 行级数据状态：区分"平台明确返回 0"和"这个字段没有可靠来源"。
 * 只要一行里同时存在 0 与 null，整行就是 PARTIAL——前端必须逐字段渲染，不能整行当 0。
 */
export function deriveRowDataStatus(metrics: Pick<SalesMetrics,
  'orderCount' | 'paidOrderCount' | 'salesQuantity' | 'grossSalesAmountMinor' |
  'paidSalesAmountMinor' | 'refundAmountMinor' | 'refundOrderCount' | 'refundQuantity' | 'netSalesAmountMinor'
> | null): SalesMetricsDataStatus {
  if (!metrics) return 'NOT_COLLECTED'
  const values = [
    metrics.orderCount, metrics.paidOrderCount, metrics.salesQuantity,
    metrics.grossSalesAmountMinor, metrics.paidSalesAmountMinor, metrics.refundAmountMinor,
    metrics.refundOrderCount, metrics.refundQuantity, metrics.netSalesAmountMinor
  ]
  const present = values.filter(value => value != null).length
  if (present === 0) return 'NOT_COLLECTED'
  // 只有**所有有值的字段都是 0**才算"平台明确返回的 0"。
  // 八个 0 加一个非 0 是 REAL_VALUE——旧写法把这种行判成 REAL_ZERO，前端会把真实成交额显示成 0。
  const allPresentAreZero = values.every(value => value == null || value === 0)
  if (present < values.length) return 'PARTIAL'
  return allPresentAreZero ? 'REAL_ZERO' : 'REAL_VALUE'
}

/**
 * 净销售额口径（§12）：gross - refund。
 * 任一算子为 null → 结果必须为 null（禁止用 0 补齐再相减，那会凭空造出"净销售额"）。
 */
export function computeNetSalesAmountMinor(
  grossSalesAmountMinor: number | null | undefined,
  refundAmountMinor: number | null | undefined
): number | null {
  if (grossSalesAmountMinor == null || refundAmountMinor == null) return null
  if (!Number.isFinite(grossSalesAmountMinor) || !Number.isFinite(refundAmountMinor)) return null
  return grossSalesAmountMinor - refundAmountMinor
}

/** 金额字段只接受"人民币分"的整数；浮点/NaN/负数一律为 null。 */
export function toMinorAmount(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  if (!Number.isInteger(number)) return null
  if (number < 0) return null
  if (Math.abs(number) > Number.MAX_SAFE_INTEGER) return null
  return number
}

/** 计数类字段只接受非负整数；`0` 是合法且必须与 null 区分。 */
export function toCount(value: unknown): number | null {
  return toMinorAmount(value)
}

/**
 * 跨平台合计门禁（§12）：口径版本不一致时不允许相加。
 * 返回 null 表示"这次合计没有可解释的口径"，前端必须显示"—"而不是 0。
 */
export function sumAcrossPlatforms(
  rows: ReadonlyArray<Pick<SalesMetrics, 'metricDefinitionVersion' | 'paidSalesAmountMinor' | 'paidOrderCount'>>,
  field: 'paidSalesAmountMinor' | 'paidOrderCount'
): number | null {
  if (!rows.length) return null
  const versions = new Set(rows.map(row => row.metricDefinitionVersion || SALES_METRICS_METRIC_DEFINITION_VERSION))
  if (versions.size !== 1) return null
  let total = 0
  let counted = 0
  for (const row of rows) {
    const value = row[field]
    if (value == null) continue
    total += value
    counted++
  }
  // 一行都没采到 → 没有可解释的合计
  return counted === 0 ? null : total
}

/** 平台抖动：由 storeId 稳定派生，同一店铺每次抖动一致（重启不会重新洗牌）。 */
export function jitterMsForStore(storeId: string): number {
  let hash = 0
  for (let index = 0; index < storeId.length; index++) {
    hash = (hash * 31 + storeId.charCodeAt(index)) % 2147483647
  }
  const span = SALES_METRICS_JITTER_MAX_MS - SALES_METRICS_JITTER_MIN_MS
  return SALES_METRICS_JITTER_MIN_MS + (hash % (span + 1))
}

/**
 * 锚定规则：过去的计划点重开新周期，未来的保持。
 */
export function anchorNextRun(nextRunAt: number | null | undefined, intervalMs: number, now: number, jitterMs = 0): number {
  const interval = Math.max(SALES_METRICS_MIN_INTERVAL_MS, Math.floor(Number(intervalMs) || SALES_METRICS_DEFAULT_INTERVAL_MS))
  const candidate = Number(nextRunAt)
  if (!Number.isFinite(candidate) || candidate <= 0) return now + interval + jitterMs
  // 未来的计划点保留；已过去（或恰好等于现在）的一律重开新周期，避免启动瞬间连发。
  if (candidate > now) return candidate
  return now + interval + jitterMs
}

/**
 * 周期边界（唯一实现，采集侧不得另写一份）。
 *
 * **按天对齐**，不用"采集时刻"当结束时间。
 *
 * 为什么必须这样：`sales_metrics` 的业务唯一键是
 * `(platform, store_id, period_start, period_end)`。如果 `period_end` 取采集那一刻，
 * 同一个"近7日"在每 10 分钟采一次的情况下每次都是**新的键**，于是每 10 分钟插一行、
 * 一天 144 行——"重复采集幂等"在真实运行里根本不成立。这不是推理出来的：
 * 真机跑通三个平台后查库，微信只有一处门店却出现了多行同口径数据，才定位到这里。
 *
 * 按天对齐后，同一天的重复采集更新同一行，`collected_at` 负责表达"什么时候刷新的"。
 * 这也正是平台自己的口径：页面上的「近7天/近7日」就是最近 7 个自然日（含今天）。
 */
export function salesMetricsPeriodBounds(
  periodType: SalesMetricsPeriodType,
  now: number = Date.now(),
  custom?: { start?: number | null; end?: number | null }
): { start: number; end: number } {
  if (periodType === 'CUSTOM' && custom?.start != null && custom?.end != null) {
    return { start: custom.start, end: custom.end }
  }
  const reference = new Date(now)
  const startOfToday = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime()
  const endOfToday = startOfToday + 86_400_000 - 1
  if (periodType === 'YESTERDAY') return { start: startOfToday - 86_400_000, end: startOfToday - 1 }
  if (periodType === 'LAST_7_DAYS') return { start: startOfToday - 6 * 86_400_000, end: endOfToday }
  if (periodType === 'LAST_30_DAYS') return { start: startOfToday - 29 * 86_400_000, end: endOfToday }
  return { start: startOfToday, end: endOfToday }
}
