import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { SalesMetricsRepository } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-repository'
import { commerceInsightServiceFor } from '../../apps/desktop/src/main/services/commerce-insight-service'
import type { SalesMetrics } from '@shared/contracts/sales-metrics'

type Db = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; close(): void }
type Ctor = new (path: string) => Db
function ctor(): Ctor | null { try { return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: Ctor }).DatabaseSync ?? null } catch { return null } }
const DbCtor = ctor()
const realIt = DbCtor ? it : it.skip

function setup() {
  const db = new DbCtor!(':memory:')
  const shim = { exec: (sql: string) => db.exec(sql), prepare: (sql: string) => db.prepare(sql), transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } } }
  migrate(shim as never)
  db.prepare('INSERT INTO stores (id,name,platform,admin_url,status,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('s1', '店铺一', '微信小店', 'https://example.invalid', 'online', '#000', 0, 0)
  db.prepare('INSERT INTO stores (id,name,platform,admin_url,status,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('s2', '店铺二', '拼多多', 'https://example.invalid', 'online', '#000', 0, 0)
  return db
}

function metric(id: string, periodStart: number, collectedAt: number, values: Partial<SalesMetrics> = {}): SalesMetrics {
  return { id, platform: '微信小店', storeId: 's1', periodType: 'TODAY', periodStart, periodEnd: periodStart + 86400000, orderCount: 3, paidOrderCount: 2, salesQuantity: 4, grossSalesAmountMinor: 1000, paidSalesAmountMinor: 800, refundAmountMinor: null, refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: null, adSpendMinor: null, collectedAt, sourceUpdatedAt: null, sourceType: 'DOM', adapterVersion: 'test', metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE', runId: null, ...values }
}

describe('commerce insight agent domain service', () => {
  realIt('compares periods without converting null to zero and preserves platform/source evidence', () => {
    const db = setup(); const repo = new SalesMetricsRepository(db as never)
    repo.upsertStoreMetrics(metric('m1', 100, Date.now() - 1000, { orderCount: null }))
    repo.upsertStoreMetrics(metric('m2', 0, Date.now() - 2000, { orderCount: 1 }))
    const result = commerceInsightServiceFor(db as never).compare({ storeId: 's1' })
    expect(result.status).toBe('SUCCEEDED')
    expect((result.summary.current as any).orderCount).toBe(null)
    expect((result.summary.changes as any).orderCount).toBe(null)
    expect((result.summary.current as any).platform).toBe('微信小店')
    db.close()
  })

  realIt('reports unavailable and stale stores explicitly', () => {
    const db = setup(); const repo = new SalesMetricsRepository(db as never)
    repo.upsertStoreMetrics(metric('old', 0, Date.now() - 3600000))
    const result = commerceInsightServiceFor(db as never).health(['s1', 's2'])
    expect(result.status).toBe('PARTIAL')
    const stores = (result.summary as any).stores
    expect(stores.find((x: any) => x.storeId === 's1').freshness).toBe('STALE')
    expect(stores.find((x: any) => x.storeId === 's2').freshness).toBe('UNAVAILABLE')
    expect(stores.find((x: any) => x.storeId === 's2').missingReason).toContain('没有')
    db.close()
  })
})
