import type { Session, WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import type {
  ProductSalesMetrics,
  ProductSalesMetricsListResult,
  SalesMetrics,
  SalesMetricsCollectionResult,
  SalesMetricsEvidenceCheck,
  SalesMetricsListResult,
  SalesMetricsPeriodType,
  SalesMetricsProductQuery,
  SalesMetricsQuery,
  SalesMetricsSourceType
} from '@shared/contracts/sales-metrics'
import {
  SALES_METRICS_METRIC_DEFINITION_VERSION,
  computeNetSalesAmountMinor,
  deriveRowDataStatus,
  salesMetricsPeriodBounds,
  toCount,
  toMinorAmount
} from '@shared/sales-metrics-rules'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type { ShopSessionStatusSummary } from '@shared/contracts/shop-session'
import type { PlatformAdapter, SalesMetricsCapableAdapter } from '../platform-adapters/platform-adapter'
import { platformAdapterRegistry } from '../platform-adapters/platform-adapter-registry'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import * as StoreManager from '../stores/store-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { waitForStoreWebContents, openStoreBrowser } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { isAppLocked } from '../services/security-manager'
import { logMain } from '../services/logger'
import { SalesMetricsRepository } from './sales-metrics-repository'
import { SalesMetricsLedger, type SalesCollectionEvidenceInput } from './sales-metrics-ledger'

export interface SalesMetricsRuntime {
  getStore: (storeId: string) => Store | null
  ensureSession: (storeId: string) => Promise<Session>
  getSessionStatus: (storeId: string) => ShopSessionStatusSummary
  /** 等店铺页面可用（含 DOM <webview> guest 注册）：页面现在由渲染层承载，开店后需要一点时间 */
  waitForStoreWebContents: (storeId: string, timeoutMs?: number) => Promise<WebContents | null>
  /** 把店铺页面在后台挂起来（display:false：不抢用户当前页），供无人值守采集自己准备页面 */
  openStorePage: (storeId: string) => void
  getAdapter: (platform: string) => PlatformAdapter | null
  detectLoginStatus: (storeId: string) => Promise<PlatformLoginResult>
  isLocked: () => boolean
  repository: SalesMetricsRepository
  ledger: SalesMetricsLedger
}

function createDefaultRuntime(): SalesMetricsRuntime {
  const database = getDatabase()
  return {
    getStore: StoreManager.getStore,
    ensureSession: ShopSessionManager.ensureSession,
    getSessionStatus: ShopSessionManager.getSessionStatus,
    waitForStoreWebContents,
    openStorePage: storeId => openStoreBrowser(storeId, { display: false, source: 'main' }),
    getAdapter: platform => platformAdapterRegistry.resolveAdapter(platform),
    detectLoginStatus: detectStoreLoginStatus,
    isLocked: isAppLocked,
    repository: new SalesMetricsRepository(database),
    ledger: new SalesMetricsLedger(database)
  }
}

function assertStoreId(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) throw new Error('INVALID_ARGUMENT')
  return storeId.trim()
}

/**
 * 周期为左闭右闭区间 [start, end]，时区 Asia/Shanghai（§12）。
 * 具体边界由 `@shared/sales-metrics-rules` 唯一实现（按天对齐、同日重复采集更新同一行）；
 * 这里只是给旧调用点保留的同名包装，避免三处各写一份周期算法。
 */
export function periodBounds(input: { periodType?: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number }): { start: number; end: number } {
  return salesMetricsPeriodBounds(input.periodType || 'TODAY', Date.now(), { start: input.periodStart, end: input.periodEnd })
}

function isCapable(adapter: PlatformAdapter | null): adapter is SalesMetricsCapableAdapter {
  return !!adapter && adapter.getCapabilities().salesMetrics === true && typeof (adapter as Partial<SalesMetricsCapableAdapter>).collectSalesMetrics === 'function'
}

function baseResult(storeId: string, platform: string, input: { periodType?: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number }): SalesMetricsCollectionResult {
  const period = periodBounds(input); const now = Date.now()
  return {
    storeId, platform, status: 'ERROR', startedAt: now, finishedAt: now,
    periodStart: period.start, periodEnd: period.end,
    storeMetricsCount: 0, productMetricsCount: 0, inserted: 0, updated: 0, skipped: 0, failed: 0,
    sourceType: 'NONE', reasonCode: 'SALES_METRICS_COLLECTION_FAILED', safeMessage: '经营数据采集失败',
    adapterVersion: null, metricDefinitionVersion: SALES_METRICS_METRIC_DEFINITION_VERSION,
    sourceUpdatedAt: null, dataStatus: 'UNKNOWN', evidence: null
  }
}

/** 证据字段的取值类型：由字段名推导，不携带数值本身。 */
function valueTypeFor(field: string): SalesCollectionEvidenceInput['valueType'] {
  if (field === 'orderCount' || field === 'paidOrderCount' || field === 'refundOrderCount') return 'ORDER_COUNT'
  if (field === 'salesQuantity' || field === 'refundQuantity') return 'QUANTITY'
  if (field.endsWith('AmountMinor')) return 'MINOR_AMOUNT'
  if (field === 'sourceUpdatedAt') return 'TIMESTAMP'
  return 'NUMBER'
}

const METRIC_FIELDS: ReadonlyArray<keyof SalesMetrics> = [
  'orderCount', 'paidOrderCount', 'salesQuantity', 'grossSalesAmountMinor',
  'paidSalesAmountMinor', 'refundAmountMinor', 'refundOrderCount', 'refundQuantity', 'netSalesAmountMinor', 'adSpendMinor'
]

/**
 * 统一化一个 Adapter 返回的指标行。
 *
 * 三件事在这里收口，Adapter 不重复实现：
 *   1. 数值只接受非负整数（金额=人民币分），浮点/负数/NaN → null，**绝不当 0**。
 *   2. 净销售额按已写明的口径补算：gross - refund，任一算子缺失则为 null。
 *   3. 逐字段推导行级数据状态：全 0 = REAL_ZERO，有 null = PARTIAL，否则 REAL_VALUE。
 */
export function normalizeStoreMetric(input: {
  metric: SalesMetrics
  storeId: string
  platform: string
  periodType: SalesMetricsPeriodType
  periodStart: number
  periodEnd: number
  collectedAt: number
  sourceType: SalesMetricsSourceType
  adapterVersion: string | null
  runId: string | null
}): SalesMetrics {
  const raw = input.metric
  const orderCount = toCount(raw.orderCount)
  const paidOrderCount = toCount(raw.paidOrderCount)
  const salesQuantity = toCount(raw.salesQuantity)
  const grossSalesAmountMinor = toMinorAmount(raw.grossSalesAmountMinor)
  const paidSalesAmountMinor = toMinorAmount(raw.paidSalesAmountMinor)
  const refundAmountMinor = toMinorAmount(raw.refundAmountMinor)
  const refundOrderCount = toCount(raw.refundOrderCount)
  const refundQuantity = toCount(raw.refundQuantity)
  const adSpendMinor = toMinorAmount(raw.adSpendMinor)
  const declaredNet = toMinorAmount(raw.netSalesAmountMinor)
  const netSalesAmountMinor = declaredNet != null
    ? declaredNet
    : (grossSalesAmountMinor != null || refundAmountMinor != null
      ? computeNetSalesAmountMinor(grossSalesAmountMinor, refundAmountMinor)
      : null)
  const normalized: SalesMetrics = {
    ...raw,
    id: raw.id,
    storeId: input.storeId,
    platform: input.platform,
    periodType: input.periodType,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    orderCount,
    paidOrderCount,
    salesQuantity,
    grossSalesAmountMinor,
    paidSalesAmountMinor,
    refundAmountMinor,
    refundOrderCount,
    refundQuantity,
    netSalesAmountMinor,
    adSpendMinor,
    collectedAt: input.collectedAt,
    sourceUpdatedAt: raw.sourceUpdatedAt == null ? null : toCount(raw.sourceUpdatedAt),
    sourceType: input.sourceType,
    adapterVersion: input.adapterVersion,
    metricDefinitionVersion: SALES_METRICS_METRIC_DEFINITION_VERSION,
    dataStatus: deriveRowDataStatus({
      orderCount, paidOrderCount, salesQuantity, grossSalesAmountMinor,
      paidSalesAmountMinor, refundAmountMinor, refundOrderCount, refundQuantity, netSalesAmountMinor, adSpendMinor
    }),
    runId: input.runId
  }
  return normalized
}

/** 由统一指标行生成脱敏证据：只写"哪个字段、什么来源、置信度"，不写数值。 */
export function evidenceRowsFor(input: {
  runId: string
  storeId: string
  platform: string
  sourceType: SalesMetricsSourceType
  sourceUrl: string
  capturedAt: number
  adapterVersion: string | null
  metrics: readonly SalesMetrics[]
  confidence?: number | null
}): SalesCollectionEvidenceInput[] {
  const rows: SalesCollectionEvidenceInput[] = []
  for (const metric of input.metrics) {
    for (const field of METRIC_FIELDS) {
      if (metric[field] == null) continue
      rows.push({
        runId: input.runId,
        storeId: input.storeId,
        platform: input.platform,
        fieldName: String(field),
        valueType: valueTypeFor(String(field)),
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        capturedAt: input.capturedAt,
        parserVersion: input.adapterVersion,
        confidence: input.confidence ?? null
      })
    }
  }
  return rows
}

/** 把 Adapter 抛出的异常/字符串错误码映射成状态机里的状态，而不是一律 ERROR。 */
export function statusForFailureCode(code: string): SalesMetricsCollectionResult['status'] {
  if (code === 'LOGIN_REQUIRED') return 'LOGIN_REQUIRED'
  if (code === 'VERIFY_REQUIRED') return 'VERIFY_REQUIRED'
  if (code === 'PERMISSION_DENIED') return 'PERMISSION_DENIED'
  if (code === 'PAGE_CHANGED') return 'PAGE_CHANGED'
  if (code === 'TIMEOUT' || code === 'DETECTION_TIMEOUT' || code === 'COLLECTION_TIMEOUT') return 'TIMEOUT'
  if (code === 'NETWORK_ERROR' || code === 'NETWORK_OBSERVER_UNAVAILABLE' || code === 'PAGE_NOT_READY') return 'NETWORK_ERROR'
  if (code === 'NO_METRICS_FOUND') return 'NO_METRICS_FOUND'
  return 'ERROR'
}

/**
 * 采集前等待页面就绪的上限：要覆盖"后台打开店铺 → 渲染层挂 webview → 主进程注册 guest →
 * 页面首次导航"这一段。调度器的单轮硬超时是 180s、Adapter 预算 90s，25s 留得下。
 */
const PAGE_READY_TIMEOUT_MS = 25 * 1000

const inFlight = new Map<string, Promise<SalesMetricsCollectionResult>>()

export class SalesMetricsCollectionService {
  private readonly runtimeFactory: () => SalesMetricsRuntime
  constructor(runtime?: SalesMetricsRuntime) { this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime }
  private get runtime(): SalesMetricsRuntime { return this.runtimeFactory() }

  /**
   * 采集一次。
   *
   * `runContext.runId` 存在时表示调用方（调度器）已经建立了运行记录，
   * 服务只负责把结果补全，不重复建一条 RUNNING。
   */
  collect(input: { storeId: string; periodType?: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number; timeoutMs?: number }, runContext?: { runId: string }): Promise<SalesMetricsCollectionResult> {
    const storeId = assertStoreId(input.storeId)
    const running = inFlight.get(storeId)
    if (running) {
      const store = this.runtime.getStore(storeId)
      const result = baseResult(storeId, store?.platform || '', input)
      result.status = 'ALREADY_RUNNING'; result.reasonCode = 'ALREADY_RUNNING'
      result.safeMessage = '该店铺正在采集经营数据，请等待当前采集完成'
      result.dataStatus = 'NOT_COLLECTED'
      return Promise.resolve(result)
    }
    const promise = this.run({ ...input, storeId }, runContext)
    inFlight.set(storeId, promise)
    return promise.finally(() => { if (inFlight.get(storeId) === promise) inFlight.delete(storeId) })
  }

  private async run(input: { storeId: string; periodType?: SalesMetricsPeriodType; periodStart?: number; periodEnd?: number; timeoutMs?: number }, runContext?: { runId: string }): Promise<SalesMetricsCollectionResult> {
    const store = this.runtime.getStore(input.storeId)
    const result = baseResult(input.storeId, store?.platform || '', input)
    try {
      if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
      if (!store) throw new Error('STORE_NOT_FOUND')
      result.platform = store.platform
      // 四个平台都进入统一调度；只有已完成真实字段/来源验证的 Adapter 才允许落库。
      // 未验证平台返回可解释状态，不伪装成"不存在能力"，这样数据中心显示"尚未验证"而不是空白。
      // 判据是 Adapter 自己的能力声明 + 已经真实验证过的 sourceType——不再按平台名硬编码。
      const adapter = this.runtime.getAdapter(store.platform)
      if (!isCapable(adapter)) {
        result.status = 'DATA_SOURCE_NOT_VERIFIED'
        result.reasonCode = 'DATA_SOURCE_NOT_VERIFIED'
        result.safeMessage = `${store.platform}经营数据源尚未完成验证`
        result.dataStatus = 'SOURCE_UNVERIFIED'
        // 未验证也要记下 Adapter 版本：将来这个平台开始有值时，"从哪一版起"是可追溯的。
        result.adapterVersion = adapter?.adapterVersion || null
        return this.finish(result, runContext)
      }
      result.adapterVersion = adapter.adapterVersion

      const session = await this.runtime.ensureSession(input.storeId)
      const sessionStatus = this.runtime.getSessionStatus(input.storeId)
      if (sessionStatus.status !== 'READY' || !sessionStatus.sessionReady) {
        result.status = 'NETWORK_ERROR'; result.reasonCode = 'SESSION_NOT_READY'
        result.safeMessage = '店铺浏览器 Session 尚未就绪'
        result.dataStatus = 'COLLECTION_FAILED'
        return this.finish(result, runContext)
      }

      // 页面：无人值守采集必须**自己**把店铺页面准备好。
      // 调度器每 10 分钟一轮，用户没开着这家店时页面句柄就是空的 —— 旧实现直接报
      // PAGE_NOT_READY（实测 20:47 那一轮四个平台全部折在这里），于是"自动采集"实际上
      // 只在对应用户手工打开过页面时才工作，数据看上去永远不更新。
      // display:false = 只把页面在后台挂起来（渲染层用隐藏的 webview 承载），不抢用户当前页。
      let webContents = await this.runtime.waitForStoreWebContents(input.storeId, 1500)
      if (!webContents) {
        try {
          this.runtime.openStorePage(input.storeId)
          logMain('info', `[sales-metrics] 采集前自动打开店铺页面 store=${input.storeId} platform=${store.platform}`)
        } catch (error) {
          // 打开失败不是这里的终局：下面仍按 PAGE_NOT_READY 如实报出（带原因）
          logMain('warn', `[sales-metrics] 自动打开店铺页面失败 store=${input.storeId}: ${String((error as Error)?.message || error)}`)
        }
        webContents = await this.runtime.waitForStoreWebContents(input.storeId, PAGE_READY_TIMEOUT_MS)
      }
      if (!webContents || webContents.isDestroyed()) {
        result.status = 'NETWORK_ERROR'; result.reasonCode = 'PAGE_NOT_READY'
        result.safeMessage = `请先打开${store.platform}店铺页面`
        result.dataStatus = 'COLLECTION_FAILED'
        return this.finish(result, runContext)
      }
      try {
        if (webContents.session && webContents.session !== session) {
          result.status = 'ERROR'; result.reasonCode = 'SESSION_MISMATCH'
          result.safeMessage = '店铺浏览器 Session 不匹配，已拒绝采集'
          result.dataStatus = 'COLLECTION_FAILED'
          return this.finish(result, runContext)
        }
      } catch {
        result.status = 'ERROR'; result.reasonCode = 'SESSION_MISMATCH'
        result.safeMessage = '店铺浏览器 Session 不匹配，已拒绝采集'
        result.dataStatus = 'COLLECTION_FAILED'
        return this.finish(result, runContext)
      }

      const login = await this.runtime.detectLoginStatus(input.storeId)
      if (login.status === 'LOGIN_REQUIRED' || login.status === 'VERIFY_REQUIRED' || login.status === 'ERROR') {
        result.status = login.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : login.status === 'VERIFY_REQUIRED' ? 'VERIFY_REQUIRED' : 'ERROR'
        result.reasonCode = login.status
        result.safeMessage = login.safeMessage
        result.dataStatus = login.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : login.status === 'VERIFY_REQUIRED' ? 'VERIFY_REQUIRED' : 'COLLECTION_FAILED'
        return this.finish(result, runContext)
      }

      const periodType: SalesMetricsPeriodType = input.periodType
        ?? (typeof adapter.getPreferredPeriodType === 'function' ? adapter.getPreferredPeriodType() : 'TODAY')
      const period = periodBounds({ ...input, periodType })
      const context = {
        storeId: input.storeId, platform: store.platform, session, webContents,
        currentUrl: (() => { try { return String(webContents.getURL() || '') } catch { return '' } })(),
        timeoutMs: input.timeoutMs || 30000
      }
      const adapterResult = await adapter.collectSalesMetrics(context,
        { periodType, periodStart: period.start, periodEnd: period.end, timeoutMs: input.timeoutMs || 30000 })

      result.status = adapterResult.status
      result.sourceType = adapterResult.sourceType
      result.reasonCode = adapterResult.reasonCode
      result.safeMessage = adapterResult.safeMessage
      result.adapterVersion = adapter.adapterVersion
      result.sourceUpdatedAt = adapterResult.sourceUpdatedAt ?? null
      result.periodStart = period.start
      result.periodEnd = period.end
      result.storeMetricsCount = Number(adapterResult.storeMetricsCount) || 0
      result.productMetricsCount = Number(adapterResult.productMetricsCount) || 0

      if (adapterResult.status === 'SUCCEEDED' || adapterResult.status === 'PARTIAL') {
        const collectedAt = Date.now()
        const storeMetrics = (adapterResult.storeMetrics || [])
          .filter(metric => metric.storeId === input.storeId && metric.platform === store.platform)
          .map(metric => normalizeStoreMetric({
            metric, storeId: input.storeId, platform: store.platform,
            periodType, periodStart: period.start, periodEnd: period.end,
            collectedAt, sourceType: adapterResult.sourceType, adapterVersion: adapter.adapterVersion,
            runId: runContext?.runId || null
          }))
        const productMetrics = (adapterResult.productMetrics || [])
          .filter(metric => metric.storeId === input.storeId && metric.platform === store.platform)

        result.skipped += (adapterResult.storeMetrics || []).length - storeMetrics.length
          + (adapterResult.productMetrics || []).length - productMetrics.length

        // 证据自检：Adapter 自称成功也要过这一关。字段与页面结构对不上 → PAGE_CHANGED；
        // 只是缺字段 → 降级 PARTIAL。绝不允许"自称成功但拿不出证据"的数据写库。
        let evidence: SalesMetricsEvidenceCheck
        try {
          evidence = adapter.verifyEvidence({ ...adapterResult, storeMetrics }, context)
        } catch {
          evidence = { ok: false, reasonCode: 'EVIDENCE_CHECK_FAILED', safeMessage: '证据自检失败', fields: [] }
        }
        result.evidence = evidence
        if (!evidence.ok) {
          const structural = evidence.reasonCode === 'PAGE_CHANGED' || evidence.reasonCode === 'EVIDENCE_SHAPE_MISMATCH'
          result.status = structural ? 'PAGE_CHANGED' : 'PARTIAL'
          result.reasonCode = evidence.reasonCode
          result.safeMessage = evidence.safeMessage
          result.dataStatus = structural ? 'PAGE_CHANGED' : 'PARTIAL'
          // 证据不通过的字段一律不写库：宁可空着，也不能把旧解析器匹配到的错数字落盘。
          if (structural) return this.finish(result, runContext)
        }

        if (storeMetrics.length || productMetrics.length) {
          const storeCounts = this.runtime.repository.upsertStoreMetricsBatch(storeMetrics)
          const productCounts = this.runtime.repository.upsertProductMetricsBatch(productMetrics)
          result.inserted = storeCounts.inserted + productCounts.inserted
          result.updated = storeCounts.updated + productCounts.updated
          result.skipped += storeCounts.skipped + productCounts.skipped
          result.dataStatus = storeMetrics.length
            ? deriveRowDataStatus(storeMetrics[0])
            : 'PARTIAL'
        } else {
          result.dataStatus = 'NOT_COLLECTED'
        }

        if (runContext?.runId && evidence.ok) {
          try {
            this.runtime.ledger.insertEvidenceBatch(evidenceRowsFor({
              runId: runContext.runId, storeId: input.storeId, platform: store.platform,
              sourceType: adapterResult.sourceType, sourceUrl: context.currentUrl,
              capturedAt: collectedAt, adapterVersion: adapter.adapterVersion,
              metrics: storeMetrics,
              confidence: evidence.fields.length ? evidence.fields.find(field => field.confidence != null)?.confidence ?? null : null
            }))
          } catch (error) {
            // 证据写入失败不回滚已经写好的指标：指标是用户要的数据，证据是可追溯性。
            logMain('warn', `[sales-metrics] evidence write failed storeId=${input.storeId}: ${String(error).slice(0, 160)}`)
          }
        }
      } else if (adapterResult.status === 'DATA_SOURCE_NOT_VERIFIED' || adapterResult.status === 'NOT_VERIFIED') {
        result.dataStatus = 'SOURCE_UNVERIFIED'
      } else if (adapterResult.status === 'NO_METRICS_FOUND') {
        result.dataStatus = 'NOT_COLLECTED'
      } else if (adapterResult.status === 'LOGIN_REQUIRED') {
        result.dataStatus = 'LOGIN_REQUIRED'
      } else if (adapterResult.status === 'VERIFY_REQUIRED') {
        result.dataStatus = 'VERIFY_REQUIRED'
      } else if (adapterResult.status === 'PERMISSION_DENIED') {
        result.dataStatus = 'PERMISSION_DENIED'
      } else if (adapterResult.status === 'PAGE_CHANGED') {
        result.dataStatus = 'PAGE_CHANGED'
      } else {
        result.dataStatus = 'COLLECTION_FAILED'
      }
      return this.finish(result, runContext)
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'SALES_METRICS_COLLECTION_FAILED'
      result.reasonCode = safeCode
      result.status = statusForFailureCode(safeCode)
      result.safeMessage = this.messageFor(safeCode)
      result.dataStatus = result.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED'
        : result.status === 'VERIFY_REQUIRED' ? 'VERIFY_REQUIRED'
        : result.status === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED'
        : result.status === 'PAGE_CHANGED' ? 'PAGE_CHANGED' : 'COLLECTION_FAILED'
      return this.finish(result, runContext)
    }
  }

  private messageFor(code: string): string {
    if (code === 'APP_LOCKED') return '应用已锁定'
    if (code === 'STORE_NOT_FOUND') return '店铺不存在或已删除'
    if (code === 'TIMEOUT' || code === 'COLLECTION_TIMEOUT' || code === 'DETECTION_TIMEOUT') return '采集超时'
    if (code === 'NETWORK_ERROR') return '网络异常，页面暂不可用'
    if (code === 'PERMISSION_DENIED') return '当前账号没有该经营数据的查看权限'
    if (code === 'PAGE_CHANGED') return '平台页面结构变化，旧解析器已暂停'
    return '经营数据采集失败'
  }

  private finish(result: SalesMetricsCollectionResult, runContext?: { runId: string }): SalesMetricsCollectionResult {
    result.finishedAt = Date.now()
    logMain('info', `[sales-metrics] ${JSON.stringify({
      platform: result.platform, storeId: result.storeId, operation: 'collectSalesMetrics',
      runId: runContext?.runId || null,
      duration: result.finishedAt - result.startedAt, result: result.status,
      sourceType: result.sourceType, reasonCode: result.reasonCode, dataStatus: result.dataStatus
    })}`)
    return result
  }

  latest(storeId: string, periodType?: SalesMetricsPeriodType): SalesMetrics | null {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const id = assertStoreId(storeId); if (!this.runtime.getStore(id)) throw new Error('STORE_NOT_FOUND')
    return this.runtime.repository.getLatestStoreMetrics(id, periodType)
  }

  list(query: SalesMetricsQuery): SalesMetricsListResult {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const id = assertStoreId(query.storeId); if (!this.runtime.getStore(id)) throw new Error('STORE_NOT_FOUND')
    return this.runtime.repository.getStoreMetrics({ ...query, storeId: id })
  }

  products(query: SalesMetricsProductQuery): ProductSalesMetricsListResult {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const id = assertStoreId(query.storeId); if (!this.runtime.getStore(id)) throw new Error('STORE_NOT_FOUND')
    return this.runtime.repository.getProductMetrics({ ...query, storeId: id })
  }

  topProducts(query: SalesMetricsProductQuery): ProductSalesMetrics[] {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const id = assertStoreId(query.storeId); if (!this.runtime.getStore(id)) throw new Error('STORE_NOT_FOUND')
    return this.runtime.repository.getTopProducts({ ...query, storeId: id })
  }
}

export const salesMetricsCollectionService = new SalesMetricsCollectionService()

export function resetSalesMetricsCollectionLocksForTests(): void { inFlight.clear() }
