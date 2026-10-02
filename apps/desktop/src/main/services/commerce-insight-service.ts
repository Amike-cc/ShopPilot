import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { collectInvoiceRows } from './overview-service'
import { SalesMetricsRepository } from '../sales-metrics/sales-metrics-repository'
import type { SalesMetrics } from '@shared/contracts/sales-metrics'
import { SALES_METRICS_AGING_MS, SALES_METRICS_FRESH_MS } from '@shared/contracts/sales-metrics'
import { buildInvoiceCsv, invoiceCsvRows } from '@shared/invoice-csv'
import { INVOICE_COLUMNS } from '@shared/constants/invoice'
import { applyEntityToStores } from './overview-service'
import { writeAudit } from './audit-logger'
import * as fs from 'node:fs'
import path from 'node:path'

export type InsightResult = {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'NOT_VERIFIED' | 'WAITING_CONFIRMATION'
  reasonCode: string
  safeMessage: string
  summary: Record<string, unknown>
  evidence: { source: string; capturedAt: number; counts?: Record<string, number> }
}

function freshness(collectedAt: number): 'FRESH' | 'AGING' | 'STALE' {
  const age = Math.max(0, Date.now() - collectedAt)
  return age <= SALES_METRICS_FRESH_MS ? 'FRESH' : age <= SALES_METRICS_AGING_MS ? 'AGING' : 'STALE'
}

function metricSummary(metric: SalesMetrics | null): Record<string, unknown> {
  if (!metric) return { dataStatus: 'NOT_COLLECTED', missingReason: '没有该店铺的经营指标快照' }
  const values = {
    orderCount: metric.orderCount,
    paidOrderCount: metric.paidOrderCount,
    salesQuantity: metric.salesQuantity,
    grossSalesAmountMinor: metric.grossSalesAmountMinor,
    paidSalesAmountMinor: metric.paidSalesAmountMinor,
    refundAmountMinor: metric.refundAmountMinor,
    refundOrderCount: metric.refundOrderCount,
    netSalesAmountMinor: metric.netSalesAmountMinor,
    adSpendMinor: metric.adSpendMinor
  }
  return {
    ...values,
    platform: metric.platform,
    periodType: metric.periodType,
    periodStart: metric.periodStart,
    periodEnd: metric.periodEnd,
    collectedAt: metric.collectedAt,
    freshness: freshness(metric.collectedAt),
    sourceType: metric.sourceType,
    adapterVersion: metric.adapterVersion,
    metricDefinitionVersion: metric.metricDefinitionVersion,
    dataStatus: metric.dataStatus,
    missingFields: Object.entries(values).filter(([, value]) => value == null).map(([key]) => key),
    runId: metric.runId
  }
}

export function commerceInsightServiceFor(db: Database.Database) {
  const metrics = new SalesMetricsRepository(db)
  return {
    compare(input: { storeId: string; period?: string }): InsightResult {
      const rows = metrics.getStoreMetrics({ storeId: input.storeId, periodType: input.period as any, page: 1, pageSize: 20 }).items
      const [current, previous] = rows
      if (!current) return {
        status: 'PARTIAL', reasonCode: 'METRICS_NOT_COLLECTED', safeMessage: '该店铺没有可比较的经营指标快照',
        summary: { storeId: input.storeId, current: metricSummary(null), previous: metricSummary(null), changes: {} },
        evidence: { source: 'sales_metrics', capturedAt: Date.now(), counts: { rows: 0 } }
      }
      const fields: Array<keyof SalesMetrics> = ['orderCount', 'paidOrderCount', 'salesQuantity', 'grossSalesAmountMinor', 'paidSalesAmountMinor', 'refundAmountMinor', 'refundOrderCount', 'refundQuantity', 'netSalesAmountMinor', 'adSpendMinor']
      const changes: Record<string, number | null> = {}
      for (const field of fields) {
        const a = current[field]; const b = previous?.[field]
        changes[field] = typeof a === 'number' && typeof b === 'number' ? a - b : null
      }
      return {
        status: previous ? 'SUCCEEDED' : 'PARTIAL', reasonCode: previous ? 'METRICS_COMPARED' : 'METRICS_PREVIOUS_PERIOD_MISSING',
        safeMessage: previous ? '已按平台和周期口径比较经营指标；缺失值保留为 null' : '只有一个指标周期，无法计算完整环比',
        summary: { storeId: input.storeId, current: metricSummary(current), previous: metricSummary(previous || null), changes, platformDefinition: current.metricDefinitionVersion },
        evidence: { source: 'sales_metrics', capturedAt: Date.now(), counts: { rows: rows.length } }
      }
    },
    health(storeIds: string[]): InsightResult {
      const ids = storeIds.length ? storeIds : (db.prepare("SELECT id FROM stores WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: string }>).map(row => row.id)
      const stores = ids.map(storeId => {
        const row = metrics.getLatestStoreMetrics(storeId)
        const platform = (db.prepare('SELECT platform FROM stores WHERE id=?').get(storeId) as { platform?: string } | undefined)?.platform || null
        return { storeId, platform, status: row?.dataStatus || 'NOT_COLLECTED', freshness: row ? freshness(row.collectedAt) : 'UNAVAILABLE', collectedAt: row?.collectedAt || null, sourceType: row?.sourceType || 'NONE', missingReason: row ? null : '没有经营指标快照' }
      })
      const unavailable = stores.filter(item => item.freshness === 'UNAVAILABLE' || item.status === 'LOGIN_REQUIRED' || item.status === 'PAGE_CHANGED').length
      const stale = stores.filter(item => item.freshness === 'STALE').length
      const status = !stores.length || unavailable === stores.length ? 'PARTIAL' : unavailable || stale ? 'PARTIAL' : 'SUCCEEDED'
      return { status, reasonCode: unavailable ? 'COMMERCE_HEALTH_DATA_GAPS' : stale ? 'COMMERCE_HEALTH_STALE' : 'COMMERCE_HEALTH_OK', safeMessage: '经营健康检查已完成；每家店保留来源、平台、新鲜度和缺失原因', summary: { stores, totals: { stores: stores.length, unavailable, stale } }, evidence: { source: 'sales_metrics_and_stores', capturedAt: Date.now(), counts: { stores: stores.length } } }
    },
    exportInvoices(input: { storeId: string; invoiceIds: string[]; confirmed: boolean }): InsightResult {
      if (!input.confirmed) return { status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: '发票导出需要人工确认；当前未写入文件', summary: { storeId: input.storeId, requestedIds: input.invoiceIds.length }, evidence: { source: 'invoice_export', capturedAt: Date.now(), counts: { exported: 0 } } }
      const requested = new Set(input.invoiceIds)
      const rows = collectInvoiceRows().filter(row => row.storeId === input.storeId).map(row => ({
        ...row,
        sections: (row.sections || []).map((section: any) => ({
          ...section,
          items: (section.items || []).filter((item: any) => {
            const id = String(item?.cells?.id || '').trim()
            return id && requested.has(id)
          })
        })).filter((section: any) => section.items.length)
      })).filter(row => row.sections.length)
      const data = invoiceCsvRows(rows, INVOICE_COLUMNS as any)
      const csv = buildInvoiceCsv(data)
      const dir = path.resolve(process.cwd(), 'artifacts', 'agent')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `invoice-export-${Date.now()}-${randomUUID().slice(0, 8)}.csv`)
      fs.writeFileSync(filePath, csv, 'utf8')
      writeAudit('invoice.export', 'success', { storeId: input.storeId, requestId: JSON.stringify({ requested: input.invoiceIds.length, exported: data.length }) })
      return { status: data.length ? 'SUCCEEDED' : 'PARTIAL', reasonCode: data.length ? 'INVOICE_EXPORT_CREATED' : 'INVOICE_EXPORT_EMPTY', safeMessage: data.length ? '已生成本地发票 CSV 导出文件；未执行付款或开票提交' : '该店铺没有可导出的已采集发票行', summary: { storeId: input.storeId, requestedIds: input.invoiceIds.length, exportedRows: data.length, filePath }, evidence: { source: 'invoice_snapshots', capturedAt: Date.now(), counts: { exported: data.length } } }
    },
    applyEntity(input: { storeId: string; confirmed: boolean }): InsightResult {
      if (!input.confirmed) return { status: 'WAITING_CONFIRMATION', reasonCode: 'CONFIRMATION_REQUIRED', safeMessage: '主体回填需要人工确认；冲突字段不会覆盖', summary: { storeId: input.storeId }, evidence: { source: 'entity_snapshots', capturedAt: Date.now(), counts: { written: 0 } } }
      const applied = applyEntityToStores([input.storeId])
      const row = applied.rows.find((item: any) => item.storeId === input.storeId)
      if (!row) return { status: 'FAILED', reasonCode: 'STORE_NOT_FOUND', safeMessage: '目标店铺不存在', summary: { storeId: input.storeId }, evidence: { source: 'entity_snapshots', capturedAt: Date.now(), counts: { written: 0 } } }
      const written = Object.keys((row as any).written || {}).length
      const conflicts = ((row as any).conflicts || []).length
      return { status: conflicts ? 'PARTIAL' : 'SUCCEEDED', reasonCode: conflicts ? 'ENTITY_CONFLICT_PRESERVED' : 'ENTITY_APPLIED', safeMessage: conflicts ? '主体存在冲突，已保留原值并提示人工处理' : '主体回填已完成', summary: { ...row, writtenFields: written, conflictCount: conflicts }, evidence: { source: 'entity_snapshots_and_stores', capturedAt: Date.now(), counts: { written, conflicts } } }
    }
  }
}
