/**
 * 拼多多经营数据采集器（**网络观察 + JSON 抽取器**路线，当前非生产路径）。
 *
 * ⚠ 2026-09-28 起，拼多多的经营指标生产路径是 **DOM 锚点档案**
 * （`BUSINESS_PROFILES['拼多多']` + `SalesMetricsDomAdapter`，实测商家后台首页卡片：
 * 成交金额 / 成交订单数，口径=今日实时）。本文件保留的是另一条路线的脚手架：
 * 从网络响应里抽取字段——它的注册表在生产里**故意为空**，因为从未拿到过可核对的真实响应结构，
 * 所以它只会返回 `DATA_SOURCE_NOT_VERIFIED`（这也曾是"拼多多没数据"的表象来源）。
 *
 * 将来若确认了稳定的 JSON 来源（含字段级证据），在这里注册一个
 * `verificationStatus: 'VERIFIED_REAL_PLATFORM'` 的抽取器并补上实测日期即可；
 * 在那之前不要让这条路径参与生产采集——"结构摘要像候选"不等于"字段已验证"。
 */
import type {
  ProductSalesMetrics,
  SalesMetrics,
  SalesMetricsCollectionResult,
  SalesMetricsPeriodType,
  SalesMetricsSourceType
} from '@shared/contracts/sales-metrics'
import type { PlatformAdapterContext } from '../platform-adapters/platform-adapter'
import type { NetworkObservationResult, NetworkObserver } from '../orders/network-observer'
import { deriveRowDataStatus, salesMetricsPeriodBounds, SALES_METRICS_METRIC_DEFINITION_VERSION } from '@shared/sales-metrics-rules'

export type ExtractorVerificationStatus = 'TEST_ONLY' | 'VERIFIED_REAL_PLATFORM' | 'DISABLED'

export interface PddSalesMetricsExtractorOutput {
  storeMetrics: SalesMetrics[]
  productMetrics: ProductSalesMetrics[]
  sourceType: SalesMetricsSourceType
  safeMessage?: string
}

export interface PddSalesMetricsExtractor {
  id: string
  platform: '拼多多'
  dataType: 'SALES_METRICS' | 'PRODUCT_SALES' | 'TREND'
  sourcePattern: RegExp
  version: string
  verificationStatus: ExtractorVerificationStatus
  extract: (context: PlatformAdapterContext, observation: NetworkObservationResult) => Promise<PddSalesMetricsExtractorOutput> | PddSalesMetricsExtractorOutput
}

export interface PddSalesMetricsCollectorResult extends SalesMetricsCollectionResult {
  storeMetrics: SalesMetrics[]
  productMetrics: ProductSalesMetrics[]
}

export interface PddSalesMetricsCollectorDependencies {
  createNetworkObserver?: (context: PlatformAdapterContext) => NetworkObserver
  extractors?: readonly PddSalesMetricsExtractor[]
}

function periodBounds(periodType: SalesMetricsPeriodType, periodStart?: number, periodEnd?: number): { start: number; end: number } {
  return salesMetricsPeriodBounds(periodType, Date.now(), { start: periodStart, end: periodEnd })
}

function baseResult(context: PlatformAdapterContext, periodType: SalesMetricsPeriodType, periodStart?: number, periodEnd?: number): PddSalesMetricsCollectorResult {
  const bounds = periodBounds(periodType, periodStart, periodEnd)
  const startedAt = Date.now()
  return {
    storeId: context.storeId,
    platform: '拼多多',
    status: 'DATA_SOURCE_NOT_VERIFIED',
    startedAt,
    finishedAt: startedAt,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    storeMetricsCount: 0,
    productMetricsCount: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    sourceType: 'NONE',
    reasonCode: 'DATA_SOURCE_NOT_VERIFIED',
    safeMessage: '拼多多经营数据源尚未完成验证',
    adapterVersion: 'pdd-sales-v1',
    metricDefinitionVersion: SALES_METRICS_METRIC_DEFINITION_VERSION,
    // 页面没有对外暴露数据更新时间 → null（不拿采集时刻冒充平台更新时间）
    sourceUpdatedAt: null,
    dataStatus: 'SOURCE_UNVERIFIED',
    evidence: null,
    storeMetrics: [],
    productMetrics: []
  }
}

/**
 * 拼多多经营数据采集器。
 *
 * 生产注册表故意为空：第四阶段只拿到了结构摘要，尚无可验证的真实经营数据
 * Fixture。因此生产调用不会猜测接口、不会保存订单，也不会生成 0 值数据。
 */
export class PddSalesMetricsCollector {
  private readonly createNetworkObserver?: (context: PlatformAdapterContext) => NetworkObserver
  private readonly extractors: PddSalesMetricsExtractor[]

  constructor(dependencies: PddSalesMetricsCollectorDependencies = {}) {
    this.createNetworkObserver = dependencies.createNetworkObserver
    this.extractors = [...(dependencies.extractors || [])]
  }

  registerExtractor(extractor: PddSalesMetricsExtractor): void {
    if (extractor.platform !== '拼多多' || !extractor.id || !extractor.version) throw new Error('INVALID_EXTRACTOR')
    if (this.extractors.some(item => item.id === extractor.id)) throw new Error('EXTRACTOR_ALREADY_REGISTERED')
    this.extractors.push(extractor)
  }

  listExtractors(): Array<Pick<PddSalesMetricsExtractor, 'id' | 'platform' | 'dataType' | 'version' | 'verificationStatus'>> {
    return this.extractors.map(({ id, platform, dataType, version, verificationStatus }) => ({ id, platform, dataType, version, verificationStatus }))
  }

  async collect(
    context: PlatformAdapterContext,
    options: { periodType: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number; timeoutMs: number }
  ): Promise<PddSalesMetricsCollectorResult> {
    const result = baseResult(context, options.periodType, options.periodStart, options.periodEnd)
    const extractor = this.extractors.find(item => item.verificationStatus === 'VERIFIED_REAL_PLATFORM' && item.sourcePattern.test(context.currentUrl))
    if (!extractor) return result
    if (!this.createNetworkObserver || !context.webContents || context.webContents.isDestroyed()) {
      return { ...result, status: 'ERROR', reasonCode: 'PAGE_NOT_READY', safeMessage: '当前店铺页面尚未准备好' }
    }
    try {
      const observation = await this.createNetworkObserver(context).observe({ timeoutMs: options.timeoutMs, maxResponses: 200, maxBodyBytes: 512 * 1024 })
      const extracted = await extractor.extract(context, observation)
      const storeMetrics = extracted.storeMetrics.filter(metric => metric.storeId === context.storeId && metric.platform === '拼多多')
      const productMetrics = extracted.productMetrics.filter(metric => metric.storeId === context.storeId && metric.platform === '拼多多')
      result.status = storeMetrics.length || productMetrics.length ? 'SUCCEEDED' : 'PARTIAL'
      result.reasonCode = storeMetrics.length || productMetrics.length ? 'SALES_METRICS_EXTRACTED' : 'NO_METRICS_FOUND'
      result.safeMessage = extracted.safeMessage || (storeMetrics.length ? '已获取拼多多经营指标' : '未在当前页面发现经营指标')
      result.sourceType = extracted.sourceType
      result.storeMetrics = storeMetrics
      result.productMetrics = productMetrics
      result.storeMetricsCount = storeMetrics.length
      result.productMetricsCount = productMetrics.length
      result.dataStatus = storeMetrics.length ? deriveRowDataStatus(storeMetrics[0]) : 'NOT_COLLECTED'
      result.finishedAt = Date.now()
      return result
    } catch {
      return { ...result, status: 'ERROR', reasonCode: 'DETECTION_FAILED', safeMessage: '拼多多经营数据检测失败', dataStatus: 'COLLECTION_FAILED', finishedAt: Date.now() }
    }
  }
}

export const pddSalesMetricsCollector = new PddSalesMetricsCollector()

export function createPddTestExtractor(
  output: PddSalesMetricsExtractorOutput,
  sourcePattern = /.*/
): PddSalesMetricsExtractor {
  return {
    id: 'test-fixture-pdd-sales-metrics',
    platform: '拼多多',
    dataType: 'SALES_METRICS',
    sourcePattern,
    version: 'test-fixture-1',
    verificationStatus: 'TEST_ONLY',
    extract: () => output
  }
}

