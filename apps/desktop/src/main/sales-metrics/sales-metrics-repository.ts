import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  SalesMetrics,
  SalesMetricsDataStatus,
  SalesMetricsListResult,
  SalesMetricsPeriodType,
  SalesMetricsQuery,
  SalesMetricsSourceType
} from '@shared/contracts/sales-metrics'
import {
  SALES_METRICS_METRIC_DEFINITION_VERSION,
  isKnownDataStatus
} from '@shared/sales-metrics-rules'

export interface SalesMetricsUpsertCounts {
  inserted: number
  updated: number
  skipped: number
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

export function mapStoreMetricRow(row: Record<string, unknown>): SalesMetrics {
  return {
    id: String(row.id),
    platform: String(row.platform),
    storeId: String(row.store_id),
    periodType: String(row.period_type) as SalesMetricsPeriodType,
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    orderCount: nullableNumber(row.order_count),
    paidOrderCount: nullableNumber(row.paid_order_count),
    salesQuantity: nullableNumber(row.sales_quantity),
    grossSalesAmountMinor: nullableNumber(row.gross_sales_amount_minor),
    paidSalesAmountMinor: nullableNumber(row.paid_sales_amount_minor),
    refundAmountMinor: nullableNumber(row.refund_amount_minor),
    refundOrderCount: nullableNumber(row.refund_order_count),
    refundQuantity: nullableNumber(row.refund_quantity),
    netSalesAmountMinor: nullableNumber(row.net_sales_amount_minor),
    adSpendMinor: nullableNumber(row.ad_spend_minor),
    collectedAt: Number(row.collected_at),
    sourceUpdatedAt: nullableNumber(row.source_updated_at),
    // 旧行（v17 之前写下的）没有来源列，按默认值回填：NONE 表示"没有可追溯来源"，
    // 而不是伪造一个 NETWORK。
    sourceType: (nullableString(row.source_type) || 'NONE') as SalesMetricsSourceType,
    adapterVersion: nullableString(row.adapter_version),
    metricDefinitionVersion: nullableString(row.metric_definition_version) || SALES_METRICS_METRIC_DEFINITION_VERSION,
    dataStatus: (isKnownDataStatus(row.data_status) ? row.data_status : 'UNKNOWN') as SalesMetricsDataStatus,
    runId: nullableString(row.run_id)
  }
}

function periodWhere(query: SalesMetricsQuery): { sql: string; params: Array<string | number> } {
  const where = ['store_id = ?']
  const params: Array<string | number> = [query.storeId]
  if (query.periodType) { where.push('period_type = ?'); params.push(query.periodType) }
  if (query.periodStart != null) { where.push('period_start >= ?'); params.push(query.periodStart) }
  if (query.periodEnd != null) { where.push('period_end <= ?'); params.push(query.periodEnd) }
  return { sql: where.join(' AND '), params }
}

export class SalesMetricsRepository {
  constructor(private readonly db: Database.Database) {}

  private transaction(fn: () => void): void {
    const candidate = this.db as unknown as { transaction?: (work: () => void) => () => void }
    if (typeof candidate.transaction === 'function') { candidate.transaction(fn)(); return }
    this.db.exec('BEGIN')
    try { fn(); this.db.exec('COMMIT') } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* noop */ } throw error }
  }

  upsertStoreMetrics(metric: SalesMetrics): { inserted: boolean; updated: boolean; rejected: 'OUT_OF_ORDER' | null } {
    const existing = this.db.prepare(
      'SELECT id, collected_at FROM sales_metrics WHERE platform = ? AND store_id = ? AND period_start = ? AND period_end = ?'
    ).get(metric.platform, metric.storeId, metric.periodStart, metric.periodEnd) as { id?: string; collected_at?: number } | undefined
    // 乱序写入保护：同一周期窗口内，**旧**快照不允许覆盖更新的快照。
    // 采集是并发跑两家的，重试与网络重放都可能让一个较早的观测晚到；写进去就是"数据倒退"。
    if (existing && Number(existing.collected_at) > Number(metric.collectedAt)) {
      return { inserted: false, updated: false, rejected: 'OUT_OF_ORDER' }
    }
    const id = existing?.id || metric.id || randomUUID()
    this.db.prepare(`
      INSERT INTO sales_metrics (
        id, platform, store_id, period_type, period_start, period_end,
        order_count, paid_order_count, sales_quantity, gross_sales_amount_minor,
        paid_sales_amount_minor, refund_amount_minor, refund_order_count,
        refund_quantity, net_sales_amount_minor, ad_spend_minor, collected_at, source_updated_at,
        source_type, adapter_version, metric_definition_version, data_status, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, store_id, period_start, period_end) DO UPDATE SET
        period_type = excluded.period_type,
        order_count = excluded.order_count,
        paid_order_count = excluded.paid_order_count,
        sales_quantity = excluded.sales_quantity,
        gross_sales_amount_minor = excluded.gross_sales_amount_minor,
        paid_sales_amount_minor = excluded.paid_sales_amount_minor,
        refund_amount_minor = excluded.refund_amount_minor,
        refund_order_count = excluded.refund_order_count,
        refund_quantity = excluded.refund_quantity,
        net_sales_amount_minor = excluded.net_sales_amount_minor,
        ad_spend_minor = excluded.ad_spend_minor,
        collected_at = excluded.collected_at,
        source_updated_at = excluded.source_updated_at,
        source_type = excluded.source_type,
        adapter_version = excluded.adapter_version,
        metric_definition_version = excluded.metric_definition_version,
        data_status = excluded.data_status,
        run_id = excluded.run_id
    `).run(
      id, metric.platform, metric.storeId, metric.periodType, metric.periodStart, metric.periodEnd,
      metric.orderCount, metric.paidOrderCount, metric.salesQuantity, metric.grossSalesAmountMinor,
      metric.paidSalesAmountMinor, metric.refundAmountMinor, metric.refundOrderCount,
      // v18 新增列：老调用方或手写的指标字面量可能没有这个属性，用 ?? null 兜底——
      // SQLite 绑定 undefined 会直接抛 "Provided value cannot be bound to SQLite parameter"。
      metric.refundQuantity, metric.netSalesAmountMinor, metric.adSpendMinor ?? null, metric.collectedAt, metric.sourceUpdatedAt,
      metric.sourceType || 'NONE', metric.adapterVersion, metric.metricDefinitionVersion || SALES_METRICS_METRIC_DEFINITION_VERSION,
      metric.dataStatus || 'UNKNOWN', metric.runId
    )
    return { inserted: !existing, updated: !!existing, rejected: null }
  }

  upsertStoreMetricsBatch(metrics: readonly SalesMetrics[]): SalesMetricsUpsertCounts {
    const unique = new Map<string, SalesMetrics>()
    let skipped = 0
    for (const metric of metrics) {
      if (!metric.platform || !metric.storeId || !Number.isInteger(metric.periodStart) || !Number.isInteger(metric.periodEnd)) { skipped++; continue }
      const key = `${metric.platform}\u0000${metric.storeId}\u0000${metric.periodStart}\u0000${metric.periodEnd}`
      if (unique.has(key)) { skipped++; continue }
      unique.set(key, metric)
    }
    let inserted = 0; let updated = 0
    this.transaction(() => { for (const metric of unique.values()) { const result = this.upsertStoreMetrics(metric); if (result.inserted) inserted++; else if (result.updated) updated++; else skipped++ } })
    return { inserted, updated, skipped }
  }

  getLatestStoreMetrics(storeId: string, periodType?: SalesMetricsPeriodType): SalesMetrics | null {
    const row = periodType
      ? this.db.prepare('SELECT * FROM sales_metrics WHERE store_id = ? AND period_type = ? ORDER BY collected_at DESC, period_end DESC LIMIT 1').get(storeId, periodType)
      : this.db.prepare('SELECT * FROM sales_metrics WHERE store_id = ? ORDER BY collected_at DESC, period_end DESC LIMIT 1').get(storeId)
    return row ? mapStoreMetricRow(row as Record<string, unknown>) : null
  }

  getStoreMetrics(query: SalesMetricsQuery): SalesMetricsListResult {
    const page = Math.max(1, Math.floor(query.page || 1)); const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize || 50)))
    const { sql, params } = periodWhere(query)
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM sales_metrics WHERE ${sql}`).get(...params) as { count?: number })?.count || 0)
    const rows = this.db.prepare(`SELECT * FROM sales_metrics WHERE ${sql} ORDER BY period_end DESC, collected_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>
    return { storeId: query.storeId, page, pageSize, total, items: rows.map(mapStoreMetricRow) }
  }

  getMetricsByPeriod(storeId: string, periodStart: number, periodEnd: number): SalesMetrics | null {
    const row = this.db.prepare('SELECT * FROM sales_metrics WHERE store_id = ? AND period_start = ? AND period_end = ? LIMIT 1').get(storeId, periodStart, periodEnd)
    return row ? mapStoreMetricRow(row as Record<string, unknown>) : null
  }
}

