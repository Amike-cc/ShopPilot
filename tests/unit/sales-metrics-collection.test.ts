/**
 * 四平台经营数据自动采集：调度、台账、口径、证据与 Adapter 的单元测试。
 *
 * 覆盖开发文档 §14 要求的 17 项。这里全部用**真实 SQLite**（node:sqlite 跑生产迁移）
 * 与真实的规则/台账代码路径——不是 mock 出来的结论。
 *
 * 明确不覆盖（见最终验收报告的"测试分层"）：真实平台页面读取、打包启动、连续运行。
 * 那些必须用真实登录态与真实进程验证，不能用本文件的夹具替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import { findPlatform } from '@shared/constants/platforms'
import { businessProfileFor } from '@shared/constants/business'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { SalesMetricsLedger, evidenceDigest, metricsSnapshotJson, sourceUrlHash } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-ledger'
import { SalesMetricsRepository } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-repository'
import { SalesMetricsCollectionService, normalizeStoreMetric, periodBounds, resetSalesMetricsCollectionLocksForTests, statusForFailureCode, evidenceRowsFor } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-collection-service'
import { SALES_METRICS_MAX_PARALLEL, anchorNextRun, backoffMsForFailures, computeFreshness, computeNetSalesAmountMinor, deriveDataStatus, deriveRowDataStatus, jitterMsForStore, planTransition, salesMetricsPeriodBounds, sumAcrossPlatforms } from '@shared/sales-metrics-rules'
import { parseSalesValue } from '../../apps/desktop/src/main/platform-adapters/sales-metrics-page-reader'
import { WeChatShopAdapter } from '../../apps/desktop/src/main/platform-adapters/wechat-shop-adapter'
import { KuaishouAdapter } from '../../apps/desktop/src/main/platform-adapters/kuaishou-adapter'
import { PlatformAdapterRegistry } from '../../apps/desktop/src/main/platform-adapters/platform-adapter-registry'
import {
  salesMetricsCollectionInputSchema,
  salesMetricsPlanListQuerySchema,
  salesMetricsPlanRunNowSchema,
  salesMetricsPlanUpdateSchema,
  salesMetricsRunsQuerySchema
} from '@shared/schemas/sales-metrics'
import type { SalesMetrics } from '@shared/contracts/sales-metrics'

type SqliteCtor = new (path: string) => {
  exec(sql: string): void
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
  close(): void
}

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch { return null }
}

const DatabaseSyncCtor = loadSqlite()
const realIt = DatabaseSyncCtor ? it : it.skip

// Adapter 的失败路径要在"总预算"内轮询（点不到周期控件 / 读不到值都靠轮询判定），
// 默认为 5 秒的用例超时挡不住这些真实等待，这里给整个文件放宽到 30 秒。
vi.setConfig({ testTimeout: 30_000 })

/** better-sqlite3 的 db.transaction(fn)() 语法在 node:sqlite 里没有，补一层最小适配。 */
function openDatabase(): { db: Database.Database; raw: InstanceType<SqliteCtor> } {
  const raw = new (DatabaseSyncCtor as SqliteCtor)(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  const shim = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      raw.exec('BEGIN')
      try { const result = fn(...args); raw.exec('COMMIT'); return result } catch (error) { raw.exec('ROLLBACK'); throw error }
    }
  }
  migrate(shim as unknown as Database.Database)
  return { db: shim as unknown as Database.Database, raw }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 28, 6, 0, 0)

function seedStore(db: Database.Database, id: string, name: string, platform: string): void {
  db.prepare(`INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, sort_order, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, '', 'online', '#fff', 0, '[]', ?, ?)`).run(id, name, platform, NOW, NOW)
}

const openDbs: Array<{ close(): void }> = []
afterEach(() => {
  while (openDbs.length) { try { openDbs.pop()?.close() } catch { /* ignore */ } }
  resetSalesMetricsCollectionLocksForTests()
})

function setup(): { db: Database.Database; raw: InstanceType<SqliteCtor>; ledger: SalesMetricsLedger; repository: SalesMetricsRepository } {
  const { db, raw } = openDatabase()
  openDbs.push(raw)
  return { db, raw, ledger: new SalesMetricsLedger(db), repository: new SalesMetricsRepository(db) }
}

function makeStoreRow(id: string, platform: string): { id: string; platform: string } { return { id, platform } }

/* ================================================================== *
 * 1. 迁移：建表、索引、外键
 * ================================================================== */

describe('sales metrics · 迁移与库结构', () => {
  realIt('v16/v17 建出计划、运行、脱敏证据三张表，且外键指向 stores / runs', () => {
    const { db } = setup()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining(['sales_collection_plans', 'sales_collection_runs', 'sales_metrics_raw', 'sales_metrics']))

    const planFks = db.prepare('PRAGMA foreign_key_list(sales_collection_plans)').all() as Array<{ table: string; on_delete: string }>
    expect(planFks).toEqual([expect.objectContaining({ table: 'stores', on_delete: 'CASCADE' })])
    const runFks = db.prepare('PRAGMA foreign_key_list(sales_collection_runs)').all() as Array<{ table: string }>
    expect(runFks).toEqual([expect.objectContaining({ table: 'stores' })])
    const rawFks = db.prepare('PRAGMA foreign_key_list(sales_metrics_raw)').all() as Array<{ table: string }>
    expect(rawFks.map(row => row.table).sort()).toEqual(['sales_collection_runs', 'stores'])
  })

  realIt('索引覆盖到期扫描、按店取历史与保留策略按时间删除', () => {
    const { db } = setup()
    const indexNames = (table: string) => (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`).all(table) as Array<{ name: string }>).map(row => row.name)
    expect(indexNames('sales_collection_plans')).toContain('idx_sales_collection_plans_due')
    expect(indexNames('sales_collection_runs')).toEqual(expect.arrayContaining([
      'idx_sales_collection_runs_store_time', 'idx_sales_collection_runs_status', 'idx_sales_collection_runs_created'
    ]))
    expect(indexNames('sales_metrics_raw')).toEqual(expect.arrayContaining(['idx_sales_metrics_raw_run', 'idx_sales_metrics_raw_captured']))
  })

  realIt('v17 补齐可追溯列：统一指标带来源/版本，运行记录带说明与聚合快照，证据带摘要', () => {
    const { db } = setup()
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    expect(columns('sales_metrics')).toEqual(expect.arrayContaining([
      'source_type', 'adapter_version', 'metric_definition_version', 'data_status', 'run_id'
    ]))
    expect(columns('sales_collection_runs')).toEqual(expect.arrayContaining([
      'safe_message', 'source_type', 'inserted', 'updated', 'metrics_json', 'data_status'
    ]))
    expect(columns('sales_metrics_raw')).toContain('evidence_digest')
    expect(columns('sales_collection_plans')).toContain('last_safe_message')
  })

  realIt('迁移链连续到 v18，重复执行不报错', () => {
    const versions = migrations.map(migration => migration.version)
    expect(versions).toEqual(versions.map((_, index) => index + 1))
    expect(migrations[migrations.length - 1].version).toBe(18)
    const { db } = setup()
    expect(() => migrate(db)).not.toThrow()
    // v18 只加了一列投放花费；必须是可空列，否则老库里已有的行会被强制写默认值
    const columns = (db.prepare('PRAGMA table_info(sales_metrics)').all() as Array<{ name: string; notnull: number }>)
    const adSpend = columns.find(column => column.name === 'ad_spend_minor')
    expect(adSpend).toBeTruthy()
    expect(adSpend!.notnull).toBe(0)
  })

  realIt('删除店铺时计划、运行与证据随外键级联消失（不留孤儿计划）', () => {
    const { db } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    db.prepare(`INSERT INTO sales_collection_plans (store_id, platform, enabled, interval_ms, timezone, next_run_at, updated_at) VALUES ('store_a','拼多多',1,600000,'Asia/Shanghai',?,?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, status, created_at) VALUES ('run_1','store_a','拼多多',?, 'SUCCEEDED', ?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO sales_metrics_raw (id, run_id, store_id, platform, field_name, value_type, source_type, captured_at) VALUES ('raw_1','run_1','store_a','拼多多','paidOrderCount','ORDER_COUNT','DOM',?)`).run(NOW)

    db.prepare('DELETE FROM stores WHERE id = ?').run('store_a')

    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_collection_plans').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_collection_runs').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_metrics_raw').get() as { n: number }).n).toBe(0)
  })
})

/* ================================================================== *
 * 2~5. 计划：新建、删除、首次时间、重启不补发
 * ================================================================== */

function syncOnce(ledger: SalesMetricsLedger, stores: Array<{ id: string; platform: string }>, now: number, reanchor: boolean) {
  return ledger.syncPlans({
    stores, now, intervalMs: 600_000,
    anchor: reanchor ? anchorNextRun : (previous, interval, current, jitter) => (previous != null ? previous : current + interval + jitter),
    jitterFor: jitterMsForStore
  })
}

describe('sales metrics · 计划生命周期', () => {
  realIt('新店铺自动创建计划，首次执行时间 = now + 10 分钟 + 抖动', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '微信小店')
    const created = syncOnce(ledger, [makeStoreRow('store_a', '微信小店')], NOW, true)
    expect(created.created).toBe(1)
    const plan = ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(true)
    expect(plan.intervalMs).toBe(600_000)
    expect(plan.timezone).toBe('Asia/Shanghai')
    const jitter = jitterMsForStore('store_a')
    expect(plan.nextRunAt).toBe(NOW + 600_000 + jitter)
    expect(jitter).toBeGreaterThanOrEqual(10_000)
    expect(jitter).toBeLessThanOrEqual(60_000)
    expect(plan.lastStatus).toBe('READY')
    // 抖动按 storeId 稳定派生：重启不会重新洗牌，否则每次重启都换一次相位
    expect(jitterMsForStore('store_a')).toBe(jitter)
  })

  realIt('重复同步不会重建计划，也不会把已排定的下一次采集时刻推走', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '快手小店')
    syncOnce(ledger, [makeStoreRow('store_a', '快手小店')], NOW, true)
    const scheduled = ledger.getPlan('store_a')!.nextRunAt
    for (let i = 0; i < 5; i++) syncOnce(ledger, [makeStoreRow('store_a', '快手小店')], NOW + i * 1000, false)
    expect(ledger.getPlan('store_a')!.nextRunAt).toBe(scheduled)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_collection_plans').get() as { n: number }).n).toBe(1)
  })

  realIt('重启不补发停机期间积压的周期：过去的计划点重开成 now + 周期', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '抖店')
    syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW, true)
    // 模拟停机 3 个周期：计划点落在过去
    db.prepare('UPDATE sales_collection_plans SET next_run_at = ? WHERE store_id = ?').run(NOW - 30 * 60 * 1000, 'store_a')
    const result = syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW, true)
    expect(result.reanchored).toBe(1)
    const plan = ledger.getPlan('store_a')!
    expect(plan.nextRunAt).toBe(NOW + 600_000 + jitterMsForStore('store_a'))
  })

  realIt('未来的计划点不会被重锚（用户看到的"下一次采集"必须稳定）', () => {
    const { ledger, db } = setup()
    seedStore(db, 'store_a', 'A 店', '抖店')
    syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW, true)
    const scheduled = ledger.getPlan('store_a')!.nextRunAt!
    const result = syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW + 60_000, true)
    expect(result.reanchored).toBe(0)
    expect(ledger.getPlan('store_a')!.nextRunAt).toBe(scheduled)
  })

  realIt('改周期要立刻生效：缩短周期把下一次采集提前，拉长周期不把它推后', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    syncOnce(ledger, [makeStoreRow('store_a', '拼多多')], NOW, true)
    const original = ledger.getPlan('store_a')!.nextRunAt!

    // 缩短：预期 1 分钟后（+抖动）
    ledger.updatePlanSettings('store_a', { intervalMs: 60_000 }, NOW, 7000)
    const shortened = ledger.getPlan('store_a')!
    expect(shortened.intervalMs).toBe(60_000)
    expect(shortened.nextRunAt).toBe(NOW + 60_000 + 7000)
    expect(shortened.nextRunAt!).toBeLessThan(original)

    // 拉长：下一次采集已经排在 1 分钟后，不应该被推到 30 分钟后
    ledger.updatePlanSettings('store_a', { intervalMs: 30 * 60_000 }, NOW, 7000)
    const lengthened = ledger.getPlan('store_a')!
    expect(lengthened.intervalMs).toBe(30 * 60_000)
    expect(lengthened.nextRunAt).toBe(NOW + 60_000 + 7000)

    // 暂停 → 计划点清空；重新启用 → 重新排一次
    ledger.updatePlanSettings('store_a', { enabled: false }, NOW + 1000, 7000)
    expect(ledger.getPlan('store_a')!.nextRunAt).toBeNull()
    ledger.updatePlanSettings('store_a', { enabled: true }, NOW + 2000, 7000)
    expect(ledger.getPlan('store_a')!.nextRunAt).toBe(NOW + 2000 + 30 * 60_000 + 7000)
  })

  realIt('店铺被删除（移出 listStores）后计划停用，不再参与调度', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '抖店')
    syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW, true)
    const result = syncOnce(ledger, [], NOW + 1000, false)
    expect(result.disabled).toBe(1)
    const plan = ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(false)
    expect(plan.nextRunAt).toBeNull()
    expect(plan.lastStatus).toBe('DISABLED')
    expect(plan.lastReasonCode).toBe('STORE_NOT_ACTIVE')
    expect(ledger.listDuePlans(NOW + 10 * DAY, 10)).toHaveLength(0)
  })

  realIt('暂停只停发计划点、保留上次成功值；恢复回到原周期并清零失败与熔断', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '微信小店')
    syncOnce(ledger, [makeStoreRow('store_a', '微信小店')], NOW, true)
    db.prepare('UPDATE sales_collection_plans SET last_success_at = ?, consecutive_failures = 4, last_status = ? WHERE store_id = ?')
      .run(NOW - 60_000, 'CIRCUIT_OPEN', 'store_a')

    expect(ledger.pausePlan('store_a', NOW)).toBe(true)
    let plan = ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(false)
    expect(plan.nextRunAt).toBeNull()
    expect(plan.lastSuccessAt).toBe(NOW - 60_000)   // 上次成功时间必须保留

    expect(ledger.resumePlan('store_a', NOW + 1000, 5000)).toBe(true)
    plan = ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(true)
    expect(plan.consecutiveFailures).toBe(0)
    expect(plan.backoffUntil).toBeNull()
    expect(plan.nextRunAt).toBe(NOW + 1000 + plan.intervalMs + 5000)
    expect(plan.lastStatus).toBe('READY')
  })

  realIt('「立即采集」把计划点拉到当下但不改变启用状态（暂停中的店也能单跑一次）', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '快手小店')
    syncOnce(ledger, [makeStoreRow('store_a', '快手小店')], NOW, true)
    ledger.pausePlan('store_a', NOW)
    expect(ledger.scheduleImmediate('store_a', NOW + 2000)).toBe(true)
    const plan = ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(false)
    expect(plan.nextRunAt).toBe(NOW + 2000)
  })
})

/* ================================================================== *
 * 6~10. 并发、退避、熔断、幂等、中断收敛
 * ================================================================== */

describe('sales metrics · 并发与状态机', () => {
  realIt('到期计划扫描遵守全局并发上限（同店铺只出现一次）', () => {
    const { db, ledger } = setup()
    const stores = ['store_a', 'store_b', 'store_c'].map(id => { seedStore(db, id, id, '拼多多'); return makeStoreRow(id, '拼多多') })
    syncOnce(ledger, stores, NOW, true)
    db.prepare('UPDATE sales_collection_plans SET next_run_at = ?').run(NOW - 1000)
    expect(SALES_METRICS_MAX_PARALLEL).toBe(2)
    const due = ledger.listDuePlans(NOW, SALES_METRICS_MAX_PARALLEL)
    expect(due).toHaveLength(2)
    expect(new Set(due.map(plan => plan.storeId)).size).toBe(2)
    // 并发额度用满（limit 0）时一个都不给
    expect(ledger.listDuePlans(NOW, 0)).toHaveLength(0)
    // 退避未到的店铺不参与本轮
    db.prepare('UPDATE sales_collection_plans SET next_run_at = ?, backoff_until = ? WHERE store_id = ?').run(NOW - 1000, NOW + 60_000, 'store_c')
    expect(ledger.listDuePlans(NOW, 10).map(plan => plan.storeId)).not.toContain('store_c')
  })

  realIt('退避窗口为 2 / 5 / 60 分钟，且不会被 10 分钟周期吃掉', () => {
    expect(backoffMsForFailures(0)).toBe(0)
    expect(backoffMsForFailures(1)).toBe(2 * 60 * 1000)
    expect(backoffMsForFailures(2)).toBe(5 * 60 * 1000)
    expect(backoffMsForFailures(3)).toBe(60 * 60 * 1000)
    expect(backoffMsForFailures(9)).toBe(60 * 60 * 1000)

    // 第三次失败：退避 60 分钟 > 周期 10 分钟，下一次必须是 60 分钟后
    const transition = planTransition({ status: 'NETWORK_ERROR', previousFailures: 2, now: NOW, intervalMs: 600_000, jitterMs: 0 })
    expect(transition.countsAsFailure).toBe(true)
    expect(transition.nextRunAt).toBe(NOW + 60 * 60 * 1000)
    expect(transition.backoffUntil).toBe(NOW + 60 * 60 * 1000)
    // 第一次失败：退避 2 分钟 < 周期 10 分钟 → 按正常周期
    expect(planTransition({ status: 'TIMEOUT', previousFailures: 0, now: NOW, intervalMs: 600_000, jitterMs: 0 }).nextRunAt).toBe(NOW + 600_000)
  })

  realIt('连续失败到阈值熔断，熔断后不再自动重试；成功/部分成功清零', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    syncOnce(ledger, [makeStoreRow('store_a', '拼多多')], NOW, true)

    for (let attempt = 1; attempt <= 5; attempt++) {
      const plan = ledger.getPlan('store_a')!
      const transition = planTransition({ status: 'ERROR', previousFailures: plan.consecutiveFailures, now: NOW + attempt * 1000, intervalMs: plan.intervalMs, jitterMs: 0 })
      ledger.finishRun({
        runId: `run_${attempt}`, storeId: 'store_a', status: 'ERROR', reasonCode: 'INTERNAL', safeMessage: '失败',
        adapterVersion: null, sourceType: null, dataStatus: 'COLLECTION_FAILED', inserted: 0, updated: 0,
        now: NOW + attempt * 1000, intervalMs: plan.intervalMs, jitterMs: 0, transition,
        metricsSnapshotJson: null, refreshLastSuccess: false
      })
      if (attempt < 5) expect(transition.circuitOpen).toBe(false)
      if (attempt === 5) expect(transition.circuitOpen).toBe(true)
    }
    let plan = ledger.getPlan('store_a')!
    expect(plan.consecutiveFailures).toBe(5)
    expect(plan.nextRunAt).toBeNull()
    expect(plan.lastStatus).toBe('ERROR')

    // 部分成功也算成功：清零失败计数并回到 10 分钟周期
    const recovered = planTransition({ status: 'PARTIAL', previousFailures: plan.consecutiveFailures, now: NOW + 10_000, intervalMs: plan.intervalMs, jitterMs: 7 })
    expect(recovered.countsAsFailure).toBe(false)
    expect(recovered.nextRunAt).toBe(NOW + 10_000 + plan.intervalMs + 7)
    ledger.finishRun({
      runId: 'run_recover', storeId: 'store_a', status: 'PARTIAL', reasonCode: 'SALES_METRICS_PARTIAL', safeMessage: '',
      adapterVersion: 'x', sourceType: 'DOM', dataStatus: 'PARTIAL', inserted: 0, updated: 1,
      now: NOW + 10_000, intervalMs: plan.intervalMs, jitterMs: 7, transition: recovered,
      metricsSnapshotJson: null, refreshLastSuccess: true
    })
    plan = ledger.getPlan('store_a')!
    expect(plan.consecutiveFailures).toBe(0)
    expect(plan.backoffUntil).toBeNull()
    expect(plan.lastSuccessAt).toBe(NOW + 10_000)
  })

  realIt('登录失效/验证/权限/页面改版停机等待用户，不累计为系统故障也不自动重试', () => {
    for (const status of ['LOGIN_REQUIRED', 'VERIFY_REQUIRED', 'PERMISSION_DENIED', 'PAGE_CHANGED'] as const) {
      const transition = planTransition({ status, previousFailures: 3, now: NOW, intervalMs: 600_000, jitterMs: 0 })
      expect(transition.requiresUserAction).toBe(true)
      expect(transition.countsAsFailure).toBe(false)
      expect(transition.nextRunAt).toBeNull()
    }
    // 数据源未验证不是系统故障，也不该堆熔断，但继续按正常周期记录
    const unverified = planTransition({ status: 'DATA_SOURCE_NOT_VERIFIED', previousFailures: 4, now: NOW, intervalMs: 600_000, jitterMs: 0 })
    expect(unverified.countsAsFailure).toBe(false)
    expect(unverified.circuitOpen).toBe(false)
    expect(unverified.nextRunAt).toBe(NOW + 600_000)
  })

  realIt('应用退出留下的 RUNNING 在下次启动收敛为 INTERRUPTED（绝不留在 RUNNING）', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, started_at, status, created_at) VALUES ('run_stuck','store_a','拼多多',?,?, 'RUNNING', ?)`).run(NOW, NOW, NOW)
    const fixed = ledger.reconcileOrphanRuns(NOW + 5000)
    expect(fixed).toBe(1)
    const run = ledger.latestRun('store_a')!
    expect(run.status).toBe('INTERRUPTED')
    expect(run.reasonCode).toBe('APP_RESTARTED')
    expect(run.finishedAt).toBe(NOW + 5000)
  })

  realIt('同一周期重复采集幂等：不新增行，旧快照不覆盖新快照', () => {
    const { db, repository } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    const base: SalesMetrics = {
      id: 'm1', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY',
      periodStart: 1000, periodEnd: 2000,
      orderCount: 3, paidOrderCount: 2, salesQuantity: 2,
      grossSalesAmountMinor: 12345, paidSalesAmountMinor: 12345, refundAmountMinor: 0,
      refundOrderCount: 0, refundQuantity: 0, netSalesAmountMinor: 12345,
      collectedAt: NOW, sourceUpdatedAt: null, sourceType: 'DOM', adapterVersion: 'v1',
      metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE', runId: 'run_1'
    }
    expect(repository.upsertStoreMetrics(base)).toMatchObject({ inserted: true, updated: false })
    expect(repository.upsertStoreMetrics({ ...base, collectedAt: NOW + 1000 })).toMatchObject({ inserted: false, updated: true })
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_metrics').get() as { n: number }).n).toBe(1)

    // 乱序（更旧的观测晚到）：拒绝写入，计入 skipped
    const late = repository.upsertStoreMetricsBatch([{ ...base, collectedAt: NOW - 5000, paidOrderCount: 999 }])
    expect(late.skipped).toBe(1)
    expect(repository.getLatestStoreMetrics('store_a')!.paidOrderCount).toBe(2)
  })

  realIt('失败不覆盖最近一次成功数据', () => {
    const { db, ledger, repository } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    syncOnce(ledger, [makeStoreRow('store_a', '拼多多')], NOW, true)
    repository.upsertStoreMetrics({
      id: 'm1', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY', periodStart: 1000, periodEnd: 2000,
      orderCount: 1, paidOrderCount: 1, salesQuantity: 1, grossSalesAmountMinor: 500, paidSalesAmountMinor: 500,
      refundAmountMinor: 0, refundOrderCount: 0, refundQuantity: 0, netSalesAmountMinor: 500,
      collectedAt: NOW, sourceUpdatedAt: null, sourceType: 'DOM', adapterVersion: 'v1',
      metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE', runId: 'run_ok'
    })
    const transition = planTransition({ status: 'NETWORK_ERROR', previousFailures: 0, now: NOW + 1, intervalMs: 600_000, jitterMs: 0 })
    ledger.finishRun({
      runId: 'run_bad', storeId: 'store_a', status: 'NETWORK_ERROR', reasonCode: 'PAGE_NOT_READY', safeMessage: '页面不可用',
      adapterVersion: null, sourceType: null, dataStatus: 'COLLECTION_FAILED', inserted: 0, updated: 0,
      now: NOW + 1, intervalMs: 600_000, jitterMs: 0, transition, metricsSnapshotJson: null, refreshLastSuccess: false
    })
    const stored = repository.getLatestStoreMetrics('store_a')!
    expect(stored.paidSalesAmountMinor).toBe(500)
    const plan = ledger.getPlan('store_a')!
    expect(plan.lastSuccessAt).toBeNull()      // 失败不刷新"最后成功"
    expect(plan.consecutiveFailures).toBe(1)
  })
})

/* ================================================================== *
 * 11. 真实 0 与 null
 * ================================================================== */

describe('sales metrics · 真实 0 与 null', () => {
  it('页面文本解析：0 是真实值，破折号/暂无是"没有数"', () => {
    expect(parseSalesValue('0', 'COUNT')).toEqual({ ok: true, value: 0 })
    expect(parseSalesValue('0.00', 'MINOR_CNY')).toEqual({ ok: true, value: 0 })
    expect(parseSalesValue('¥0.00', 'MINOR_CNY')).toEqual({ ok: true, value: 0 })
    expect(parseSalesValue('—', 'COUNT').ok).toBe(false)
    expect(parseSalesValue('--', 'COUNT').ok).toBe(false)
    expect(parseSalesValue('', 'COUNT')).toMatchObject({ reason: 'NO_VALUE' })
    expect(parseSalesValue('暂无', 'COUNT')).toMatchObject({ reason: 'NO_VALUE' })
  })

  it('金额按元→分换算，万/亿后缀按平台显示规则放大，未知后缀为 null', () => {
    expect(parseSalesValue('12.34', 'MINOR_CNY')).toEqual({ ok: true, value: 1234 })
    expect(parseSalesValue('1,234.56', 'MINOR_CNY')).toEqual({ ok: true, value: 123456 })
    expect(parseSalesValue('1.2万', 'MINOR_CNY')).toEqual({ ok: true, value: 1_200_000 })
    expect(parseSalesValue('1亿', 'COUNT')).toEqual({ ok: true, value: 100_000_000 })
    expect(parseSalesValue('12%', 'COUNT').ok).toBe(false)
    expect(parseSalesValue('1000+', 'COUNT')).toMatchObject({ reason: 'APPROXIMATE_VALUE' })
    expect(parseSalesValue('-3', 'COUNT')).toMatchObject({ reason: 'NEGATIVE' })
  })

  it('归一化：非法数值变 null（不是 0），合法 0 保留为 0', () => {
    const raw = {
      id: 'm', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY' as const, periodStart: 0, periodEnd: 0,
      orderCount: 0, paidOrderCount: null, salesQuantity: 3.7, grossSalesAmountMinor: -5,
      paidSalesAmountMinor: Number.NaN, refundAmountMinor: 0, refundOrderCount: null, refundQuantity: null,
      netSalesAmountMinor: null, collectedAt: 0, sourceUpdatedAt: null, sourceType: 'NONE' as const,
      adapterVersion: null, metricDefinitionVersion: 'x', dataStatus: 'UNKNOWN' as const, runId: null
    }
    const metric = normalizeStoreMetric({
      metric: raw, storeId: 'store_a', platform: '拼多多', periodType: 'TODAY', periodStart: 1, periodEnd: 2,
      collectedAt: NOW, sourceType: 'DOM', adapterVersion: 'v1', runId: 'run_1'
    })
    expect(metric.orderCount).toBe(0)                  // 真实 0 保留
    expect(metric.paidOrderCount).toBeNull()           // 缺失保持 null
    expect(metric.salesQuantity).toBeNull()            // 浮点计数不接受
    expect(metric.grossSalesAmountMinor).toBeNull()    // 负数金额不接受
    expect(metric.paidSalesAmountMinor).toBeNull()     // NaN 不接受
    expect(metric.refundAmountMinor).toBe(0)
    expect(metric.sourceType).toBe('DOM')
    expect(metric.adapterVersion).toBe('v1')
    expect(metric.runId).toBe('run_1')
  })

  it('净销售额口径：gross - refund；任一算子缺失则为 null（不用 0 补齐）', () => {
    expect(computeNetSalesAmountMinor(1000, 250)).toBe(750)
    expect(computeNetSalesAmountMinor(0, 0)).toBe(0)
    expect(computeNetSalesAmountMinor(1000, null)).toBeNull()
    expect(computeNetSalesAmountMinor(null, 250)).toBeNull()
    expect(computeNetSalesAmountMinor(null, null)).toBeNull()

    const metric = normalizeStoreMetric({
      metric: {
        id: 'm', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY', periodStart: 0, periodEnd: 0,
        orderCount: null, paidOrderCount: null, salesQuantity: null,
        grossSalesAmountMinor: 1000, paidSalesAmountMinor: null, refundAmountMinor: null,
        refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: null,
        collectedAt: 0, sourceUpdatedAt: null, sourceType: 'NONE', adapterVersion: null,
        metricDefinitionVersion: 'x', dataStatus: 'UNKNOWN', runId: null
      },
      storeId: 'store_a', platform: '拼多多', periodType: 'TODAY', periodStart: 1, periodEnd: 2,
      collectedAt: NOW, sourceType: 'DOM', adapterVersion: 'v1', runId: null
    })
    expect(metric.netSalesAmountMinor).toBeNull()
  })

  it('行级数据状态区分全 0 / 部分 / 有值 / 无值', () => {
    const zero = { orderCount: 0, paidOrderCount: 0, salesQuantity: 0, grossSalesAmountMinor: 0, paidSalesAmountMinor: 0, refundAmountMinor: 0, refundOrderCount: 0, refundQuantity: 0, netSalesAmountMinor: 0, adSpendMinor: 0 }
    expect(deriveRowDataStatus(null)).toBe('NOT_COLLECTED')
    expect(deriveRowDataStatus({ ...zero, orderCount: null })).toBe('PARTIAL')
    expect(deriveRowDataStatus(zero)).toBe('REAL_ZERO')
    expect(deriveRowDataStatus({ ...zero, paidSalesAmountMinor: 100 })).toBe('REAL_VALUE')
    // v18 起"投放花费"也算行内字段：快手/微信没有可读的投放来源 → adSpend 为 null → 整行 PARTIAL。
    // 这是有意的：整行状态要回答"这套指标齐不齐"，不能在缺一项时仍宣称 REAL_ZERO。
    expect(deriveRowDataStatus({ ...zero, adSpendMinor: null })).toBe('PARTIAL')
    expect(deriveRowDataStatus({ ...zero, orderCount: null, paidOrderCount: null, salesQuantity: null, grossSalesAmountMinor: null, paidSalesAmountMinor: null, refundAmountMinor: null, refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: null, adSpendMinor: null })).toBe('NOT_COLLECTED')
  })

  it('跨平台合计只在口径版本一致时成立，否则为 null（前端显示"—"）', () => {
    const rows = [
      { metricDefinitionVersion: 'sales-metrics-1', paidSalesAmountMinor: 100, paidOrderCount: 1 },
      { metricDefinitionVersion: 'sales-metrics-1', paidSalesAmountMinor: 200, paidOrderCount: 2 }
    ]
    expect(sumAcrossPlatforms(rows, 'paidSalesAmountMinor')).toBe(300)
    expect(sumAcrossPlatforms(rows, 'paidOrderCount')).toBe(3)
    expect(sumAcrossPlatforms([...rows, { metricDefinitionVersion: 'sales-metrics-2', paidSalesAmountMinor: 5, paidOrderCount: 1 }], 'paidSalesAmountMinor')).toBeNull()
    expect(sumAcrossPlatforms([], 'paidSalesAmountMinor')).toBeNull()
    expect(sumAcrossPlatforms([{ metricDefinitionVersion: 'sales-metrics-1', paidSalesAmountMinor: null, paidOrderCount: null }], 'paidSalesAmountMinor')).toBeNull()
  })
})

/* ================================================================== *
 * 12. 新鲜度与数据状态
 * ================================================================== */

describe('sales metrics · 新鲜度', () => {
  it('FRESH <= 10 分钟，AGING 10~30 分钟，STALE > 30 分钟，从未成功 UNAVAILABLE', () => {
    expect(computeFreshness({ lastSuccessAt: NOW - 60_000, lastStatus: 'SUCCEEDED', now: NOW })).toBe('FRESH')
    expect(computeFreshness({ lastSuccessAt: NOW - 10 * 60_000, lastStatus: 'SUCCEEDED', now: NOW })).toBe('FRESH')
    expect(computeFreshness({ lastSuccessAt: NOW - 20 * 60_000, lastStatus: 'SUCCEEDED', now: NOW })).toBe('AGING')
    expect(computeFreshness({ lastSuccessAt: NOW - 31 * 60_000, lastStatus: 'SUCCEEDED', now: NOW })).toBe('STALE')
    expect(computeFreshness({ lastSuccessAt: null, lastStatus: 'ERROR', now: NOW })).toBe('UNAVAILABLE')
    expect(computeFreshness({ lastSuccessAt: NOW, lastStatus: 'DATA_SOURCE_NOT_VERIFIED', now: NOW })).toBe('SOURCE_UNVERIFIED')
    expect(computeFreshness({ lastSuccessAt: NOW, lastStatus: 'NOT_VERIFIED', now: NOW })).toBe('SOURCE_UNVERIFIED')
  })

  it('数据状态覆盖每种可区分的情形（未采集/失败/登录/权限/改版/过期/暂停/熔断/部分）', () => {
    const base = { hasMetrics: false, intervalMs: 600_000, now: NOW, lastSuccessAt: null, freshness: 'UNAVAILABLE' as const }
    expect(deriveDataStatus({ ...base, lastStatus: 'READY' })).toBe('NOT_COLLECTED')
    expect(deriveDataStatus({ ...base, lastStatus: null })).toBe('NOT_COLLECTED')
    expect(deriveDataStatus({ ...base, lastStatus: 'ERROR' })).toBe('COLLECTION_FAILED')
    expect(deriveDataStatus({ ...base, lastStatus: 'TIMEOUT' })).toBe('COLLECTION_FAILED')
    expect(deriveDataStatus({ ...base, lastStatus: 'LOGIN_REQUIRED' })).toBe('LOGIN_REQUIRED')
    expect(deriveDataStatus({ ...base, lastStatus: 'VERIFY_REQUIRED' })).toBe('VERIFY_REQUIRED')
    expect(deriveDataStatus({ ...base, lastStatus: 'PERMISSION_DENIED' })).toBe('PERMISSION_DENIED')
    expect(deriveDataStatus({ ...base, lastStatus: 'PAGE_CHANGED' })).toBe('PAGE_CHANGED')
    expect(deriveDataStatus({ ...base, lastStatus: 'DATA_SOURCE_NOT_VERIFIED' })).toBe('SOURCE_UNVERIFIED')
    expect(deriveDataStatus({ ...base, lastStatus: 'DISABLED' })).toBe('PAUSED')
    expect(deriveDataStatus({ ...base, lastStatus: 'CIRCUIT_OPEN' })).toBe('CIRCUIT_OPEN')
    expect(deriveDataStatus({ ...base, lastStatus: 'PARTIAL' })).toBe('PARTIAL')
    expect(deriveDataStatus({ ...base, lastStatus: 'SUCCEEDED', hasMetrics: true, freshness: 'FRESH', lastSuccessAt: NOW })).toBe('REAL_VALUE')
    expect(deriveDataStatus({ ...base, lastStatus: 'SUCCEEDED', hasMetrics: true, freshness: 'STALE', lastSuccessAt: NOW - DAY })).toBe('DATA_STALE')
  })

  it('锚定规则：过去的计划点重开新周期，未来的保持', () => {
    expect(anchorNextRun(NOW + 60_000, 600_000, NOW)).toBe(NOW + 60_000)
    expect(anchorNextRun(NOW - 10 * 600_000, 600_000, NOW)).toBe(NOW + 600_000)
    expect(anchorNextRun(NOW, 600_000, NOW)).toBe(NOW + 600_000)
    expect(anchorNextRun(null, 600_000, NOW, 5000)).toBe(NOW + 600_000 + 5000)
  })
})

/* ================================================================== *
 * 周期边界与幂等（真机查库后补的回归）
 * ================================================================== */

describe('sales metrics · 周期边界与幂等', () => {
  it('周期按天对齐：同一天内重复采集落在同一周期键上', () => {
    const noon = new Date(2026, 8, 28, 12, 0, 0).getTime()
    const evening = new Date(2026, 8, 28, 20, 30, 0).getTime()
    // 真机踩过：period_end 取"采集时刻"时，每 10 分钟采集一次就是每 10 分钟插一行——
    // "重复采集幂等"在真实运行里根本不成立（跑完三个平台查库才发现）。
    expect(salesMetricsPeriodBounds('TODAY', noon)).toEqual(salesMetricsPeriodBounds('TODAY', evening))
    expect(salesMetricsPeriodBounds('LAST_7_DAYS', noon)).toEqual(salesMetricsPeriodBounds('LAST_7_DAYS', evening))
    const today = salesMetricsPeriodBounds('TODAY', noon)
    expect(new Date(today.start).getHours()).toBe(0)
    expect(new Date(today.start).getMinutes()).toBe(0)
    expect(today.end - today.start).toBe(86_400_000 - 1)
    const week = salesMetricsPeriodBounds('LAST_7_DAYS', noon)
    expect(week.end).toBe(today.end)
    expect(today.start - week.start).toBe(6 * 86_400_000)
    // 跨天才换周期（近7日窗口每天向前滑一天）
    const tomorrow = salesMetricsPeriodBounds('LAST_7_DAYS', new Date(2026, 8, 29, 9, 0, 0).getTime())
    expect(tomorrow.start - week.start).toBe(86_400_000)
    // 昨天：整日
    const yesterday = salesMetricsPeriodBounds('YESTERDAY', noon)
    expect(yesterday.end - yesterday.start).toBe(86_400_000 - 1)
    expect(yesterday.end).toBe(today.start - 1)
    // CUSTOM 原样使用调用方给的起止
    expect(salesMetricsPeriodBounds('CUSTOM', noon, { start: 1000, end: 2000 })).toEqual({ start: 1000, end: 2000 })
  })

  realIt('同一天两次采集同一平台同一周期 → 只有一行（更新而非新增）', () => {
    const { db, repository } = setup()
    seedStore(db, 'store_a', 'A 店', '微信小店')
    const bounds = salesMetricsPeriodBounds('LAST_7_DAYS', new Date(2026, 8, 28, 10, 0, 0).getTime())
    const base = {
      id: 'm', platform: '微信小店', storeId: 'store_a', periodType: 'LAST_7_DAYS' as const,
      periodStart: bounds.start, periodEnd: bounds.end,
      orderCount: null, paidOrderCount: 11, salesQuantity: null,
      grossSalesAmountMinor: 10890, paidSalesAmountMinor: null, refundAmountMinor: 0,
      refundOrderCount: null, refundQuantity: null, netSalesAmountMinor: 10890,
      sourceUpdatedAt: null, sourceType: 'DOM' as const, adapterVersion: 'wechat-shop-sales-v1',
      metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE' as const, runId: 'run_1'
    }
    repository.upsertStoreMetrics({ ...base, collectedAt: new Date(2026, 8, 28, 10, 0, 0).getTime() })
    repository.upsertStoreMetrics({ ...base, collectedAt: new Date(2026, 8, 28, 15, 30, 0).getTime(), paidOrderCount: 13 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales_metrics').get() as { n: number }).n).toBe(1)
    expect(repository.getLatestStoreMetrics('store_a')!.paidOrderCount).toBe(13)
  })
})

/* ================================================================== *
 * 15. 证据摘要不含敏感信息
 * ================================================================== */

describe('sales metrics · 脱敏证据', () => {
  realIt('证据表只写字段形状，摘要与 URL 哈希都不含原值', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '微信小店')
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, status, created_at) VALUES ('run_1','store_a','微信小店',?, 'SUCCEEDED', ?)`).run(NOW, NOW)

    const digest = evidenceDigest({ storeId: 'store_a', platform: '微信小店', fieldName: 'paidSalesAmountMinor', valueType: 'MINOR_AMOUNT', sourceType: 'DOM', parserVersion: 'v1' })
    const url = 'https://store.weixin.qq.com/shop/home?session=secret-token&buyer=13800000000'
    ledger.insertEvidenceBatch([{
      runId: 'run_1', storeId: 'store_a', platform: '微信小店', fieldName: 'paidSalesAmountMinor',
      valueType: 'MINOR_AMOUNT', sourceType: 'DOM', sourceUrl: url, capturedAt: NOW,
      parserVersion: 'v1', confidence: 0.9
    }])

    const row = db.prepare('SELECT * FROM sales_metrics_raw').get() as Record<string, unknown>
    const serialized = JSON.stringify(row)
    expect(row.source_url_hash).toBe(sourceUrlHash(url))
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('13800000000')
    expect(serialized).not.toContain('store.weixin.qq.com')
    expect(row.evidence_digest).toBe(digest)
    // 表里根本没有存放原始值/凭据的列
    const columns = (db.prepare('PRAGMA table_info(sales_metrics_raw)').all() as Array<{ name: string }>).map(item => item.name)
    for (const forbidden of ['value', 'value_json', 'body', 'response', 'cookie', 'token', 'header', 'raw_text']) {
      expect(columns).not.toContain(forbidden)
    }
    expect(ledger.evidenceCountForRun('run_1')).toBe(1)
  })

  it('由指标生成证据时只产出字段名与来源，不含数值', () => {
    const metric: SalesMetrics = {
      id: 'm', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY', periodStart: 1, periodEnd: 2,
      orderCount: 7, paidOrderCount: 6, salesQuantity: null, grossSalesAmountMinor: 12345,
      paidSalesAmountMinor: null, refundAmountMinor: null, refundOrderCount: null, refundQuantity: null,
      netSalesAmountMinor: null, collectedAt: NOW, sourceUpdatedAt: null, sourceType: 'DOM',
      adapterVersion: 'v1', metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'PARTIAL', runId: 'run_1'
    }
    const rows = evidenceRowsFor({
      runId: 'run_1', storeId: 'store_a', platform: '拼多多', sourceType: 'DOM',
      sourceUrl: 'https://mms.pinduoduo.com/x', capturedAt: NOW, adapterVersion: 'v1', metrics: [metric]
    })
    expect(rows.map(row => row.fieldName).sort()).toEqual(['grossSalesAmountMinor', 'orderCount', 'paidOrderCount'])
    expect(JSON.stringify(rows)).not.toContain('12345')
    expect(JSON.stringify(rows)).not.toContain('"7"')
    expect(rows.find(row => row.fieldName === 'grossSalesAmountMinor')?.valueType).toBe('MINOR_AMOUNT')
    expect(rows.find(row => row.fieldName === 'orderCount')?.valueType).toBe('ORDER_COUNT')
  })

  realIt('运行记录的 metrics_json 只存聚合指标（不含商品明细/买家信息）', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, status, created_at) VALUES ('run_1','store_a','拼多多',?, 'SUCCEEDED', ?)`).run(NOW, NOW)
    const repository = new SalesMetricsRepository(db)
    repository.upsertStoreMetrics({
      id: 'm', platform: '拼多多', storeId: 'store_a', periodType: 'TODAY', periodStart: 1, periodEnd: 2,
      orderCount: 1, paidOrderCount: 1, salesQuantity: 1, grossSalesAmountMinor: 100,
      paidSalesAmountMinor: 100, refundAmountMinor: 0, refundOrderCount: 0, refundQuantity: 0,
      netSalesAmountMinor: 100, adSpendMinor: 30, collectedAt: NOW, sourceUpdatedAt: null, sourceType: 'DOM',
      adapterVersion: 'v1', metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE', runId: 'run_1'
    })
    expect(ledger.attachRunMetricsSnapshot('run_1', 'store_a')).toBe(1)
    const row = db.prepare('SELECT metrics_json FROM sales_collection_runs WHERE run_id = ?').get('run_1') as { metrics_json: string }
    const snapshot = JSON.parse(row.metrics_json) as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual([
      'adSpendMinor', 'grossSalesAmountMinor', 'netSalesAmountMinor', 'orderCount', 'paidOrderCount', 'paidSalesAmountMinor',
      'periodEnd', 'periodStart', 'refundAmountMinor', 'refundOrderCount', 'refundQuantity', 'salesQuantity'
    ])
    expect(metricsSnapshotJson(null)).toBeNull()
  })

  realIt('趋势只取成功点：失败运行不产生趋势点，也不补 0', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, finished_at, status, created_at, metrics_json) VALUES
      ('run_ok','store_a','拼多多',?,?, 'SUCCEEDED', ?, ?),
      ('run_bad','store_a','拼多多',?,?, 'NETWORK_ERROR', ?, NULL)`).run(
      NOW, NOW, NOW, JSON.stringify({ paidSalesAmountMinor: 500, paidOrderCount: 2, refundAmountMinor: 0 }),
      NOW + 1000, NOW + 1000, NOW + 1000
    )
    const trend = ledger.trend('store_a', NOW - DAY)
    expect(trend).toHaveLength(2)
    expect(trend[0]).toMatchObject({ status: 'SUCCEEDED', paidSalesAmountMinor: 500, paidOrderCount: 2 })
    expect(trend[1]).toMatchObject({ status: 'NETWORK_ERROR', paidSalesAmountMinor: null, paidOrderCount: null })
  })
})

/* ================================================================== *
 * 13~14. IPC schema 与锁定/未验证门禁
 * ================================================================== */

describe('sales metrics · IPC 契约', () => {
  it('strict schema 拒绝多传字段（Renderer 不能夹带 SQL/URL/Session/脚本）', () => {
    const base = { storeId: 'store_a' }
    expect(salesMetricsPlanListQuerySchema.safeParse({ ...base, sql: 'SELECT 1' }).success).toBe(false)
    expect(salesMetricsPlanListQuerySchema.safeParse({ ...base, url: 'https://example.com' }).success).toBe(false)
    expect(salesMetricsPlanRunNowSchema.safeParse({ storeId: 'store_a', script: 'alert(1)' }).success).toBe(false)
    expect(salesMetricsPlanRunNowSchema.safeParse({ storeId: 'store_a', webContents: {} }).success).toBe(false)
    expect(salesMetricsRunsQuerySchema.safeParse({ storeId: 'store_a' }).success).toBe(true)
    expect(salesMetricsRunsQuerySchema.safeParse({ session: 'x' }).success).toBe(false)
    expect(salesMetricsPlanListQuerySchema.safeParse({}).success).toBe(true)
    expect(salesMetricsCollectionInputSchema.safeParse({ storeId: 'store_a', timeoutMs: 500 }).success).toBe(false)
  })

  it('周期只能在 1 分钟～24 小时之间，且更新请求必须至少改一项', () => {
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', intervalMs: 59_999 }).success).toBe(false)
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', intervalMs: 60_000 }).success).toBe(true)
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', intervalMs: 24 * 3600 * 1000 }).success).toBe(true)
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', intervalMs: 24 * 3600 * 1000 + 1 }).success).toBe(false)
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a' }).success).toBe(false)
    expect(salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', enabled: false }).success).toBe(true)
  })

  it('周期范围常量与 schema 一致（两处各写一套会漂移）', () => {
    const parsed = salesMetricsPlanUpdateSchema.safeParse({ storeId: 'store_a', intervalMs: 600_000 })
    expect(parsed.success).toBe(true)
    expect(periodBounds({ periodType: 'TODAY' }).end - periodBounds({ periodType: 'TODAY' }).start).toBeGreaterThan(0)
  })
})

describe('sales metrics · 采集服务门禁', () => {
  const SESSION = {} as never
  function fakeStore(id: string, platform: string) { return { id, platform } as unknown as ReturnType<typeof buildStore> }
  function buildStore() { return { id: '', platform: '', status: 'online' } }

  function serviceWith(overrides: Partial<Parameters<typeof makeRuntime>[0]> = {}) {
    return new SalesMetricsCollectionService(makeRuntime(overrides))
  }

  function makeRuntime(options: {
    locked?: boolean
    platform?: string
    adapter?: unknown
    hasPage?: boolean
    loginStatus?: string
    /** 模拟"采集自己开店后页面就绪"：openStorePage 被调用后 waitForStoreWebContents 才有值 */
    pageComesAfterOpen?: boolean
  } = {}) {
    const platform = options.platform || '拼多多'
    const page = {
      isDestroyed: () => false,
      getURL: () => 'https://mms.pinduoduo.com/',
      session: SESSION
    } as unknown as WebContents
    let opened = false
    const webContents = options.hasPage === false && !options.pageComesAfterOpen ? null : page
    const runtime = {
      getStore: () => fakeStore('store_a', platform),
      ensureSession: async () => SESSION,
      getSessionStatus: () => ({
        storeId: 'store_a', status: 'READY', sessionPresent: true, sessionReady: true, healthy: true,
        loginStatus: 'UNKNOWN', platform, lastCheckedAt: NOW, loginCheckedAt: null, loginReasonCode: null,
        loginSafeMessage: null, loginEvidenceType: null, errorCode: null
      }),
      // 页面句柄现在要等渲染层 DOM <webview> 注册完成：服务侧接口是"等到可用为止"，
      // 因此这里返回 Promise；hasPage:false 表示等不到（页面没打开）。
      waitForStoreWebContents: async () => (options.pageComesAfterOpen && !opened ? null : webContents),
      openStorePage: vi.fn(() => { opened = true }),
      getAdapter: () => (options.adapter === undefined ? null : options.adapter) as never,
      detectLoginStatus: async () => ({
        platform, storeId: 'store_a', status: (options.loginStatus || 'UNKNOWN') as never,
        checkedAt: NOW, reasonCode: 'TEST', safeMessage: '测试', evidenceType: 'DOM'
      }),
      isLocked: () => !!options.locked,
      repository: { upsertStoreMetricsBatch: () => ({ inserted: 0, updated: 0, skipped: 0 }), upsertProductMetricsBatch: () => ({ inserted: 0, updated: 0, skipped: 0 }) } as never,
      ledger: { insertEvidenceBatch: () => 0 } as never
    }
    return runtime
  }

  /** 能读出指标的假 Adapter：验证"页面就绪后确实进入了采集流程" */
  function capableAdapter() {
    return {
      getCapabilities: () => ({ salesMetrics: true }),
      adapterVersion: 'test-1',
      getPreferredPeriodType: () => 'TODAY',
      verifyEvidence: () => ({ ok: true, reasonCode: 'OK', safeMessage: '', fields: [] }),
      collectSalesMetrics: async () => ({
        status: 'SUCCEEDED', reasonCode: 'SALES_METRICS_READ_FROM_PAGE', safeMessage: '测试读取',
        sourceType: 'DOM',
        storeMetrics: [{
          storeId: 'store_a', platform: '拼多多', periodType: 'TODAY',
          periodStart: NOW, periodEnd: NOW,
          orderCount: 3, paidOrderCount: 3, salesQuantity: 3,
          grossSalesAmountMinor: 1234, paidSalesAmountMinor: 1234,
          refundAmountMinor: 0, refundOrderCount: 0, refundQuantity: 0,
          netSalesAmountMinor: 1234, collectedAt: NOW, sourceUpdatedAt: null
        }],
        productMetrics: [],
        storeMetricsCount: 1,
        productMetricsCount: 0
      })
    }
  }

  it('页面没打开时采集自己把店铺页面挂起来再读（无人值守采集不能只靠用户手工开页）', async () => {
    // 旧行为：页面句柄为空 → 直接 PAGE_NOT_READY，于是"每 10 分钟自动采集"只要用户没开着店
    // 就永远采不到（实测 20:47 那一轮四个平台全折在这）。现在必须先自己开页面。
    const runtime = makeRuntime({ hasPage: false, pageComesAfterOpen: true, adapter: capableAdapter() })
    const service = new SalesMetricsCollectionService(runtime as never)
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect((runtime.openStorePage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
    expect(result.reasonCode).not.toBe('PAGE_NOT_READY')
    expect(result.status).toBe('SUCCEEDED')
  })

  it('自己开店后页面仍不可用时，如实报 PAGE_NOT_READY（不是静默成功）', async () => {
    const runtime = makeRuntime({ hasPage: false, adapter: capableAdapter() })
    const service = new SalesMetricsCollectionService(runtime as never)
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect((runtime.openStorePage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
    expect(result.status).toBe('NETWORK_ERROR')
    expect(result.reasonCode).toBe('PAGE_NOT_READY')
    expect(result.inserted).toBe(0)
  })

  it('应用锁定时拒绝采集，且不返回成功状态', async () => {
    const service = serviceWith({ locked: true })
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect(result.status).not.toBe('SUCCEEDED')
    expect(result.reasonCode).toBe('APP_LOCKED')
    expect(result.inserted).toBe(0)
    expect(result.dataStatus).toBe('COLLECTION_FAILED')
  })

  it('没有经营数据能力的平台返回 DATA_SOURCE_NOT_VERIFIED，绝不显示为正常成功', async () => {
    const service = serviceWith({
      platform: '拼多多',
      adapter: { adapterName: 'X', adapterVersion: 'v9', platform: '拼多多', supports: () => true, getCapabilities: () => ({ loginDetection: true, orders: false, salesMetrics: false, productSalesMetrics: false, products: false, inventory: false, refunds: false, salesData: false }) }
    })
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect(result.status).toBe('DATA_SOURCE_NOT_VERIFIED')
    expect(result.dataStatus).toBe('SOURCE_UNVERIFIED')
    expect(result.adapterVersion).toBe('v9')
    expect(result.inserted + result.updated).toBe(0)
  })

  it('页面未打开时返回网络类失败，不写任何数据', async () => {
    const service = serviceWith({
      platform: '拼多多',
      hasPage: false,
      adapter: { adapterName: 'X', adapterVersion: 'v1', platform: '拼多多', supports: () => true, getCapabilities: () => ({ loginDetection: true, orders: false, salesMetrics: true, productSalesMetrics: false, products: false, inventory: false, refunds: false, salesData: false }), collectSalesMetrics: () => ({ status: 'SUCCEEDED' }) }
    })
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect(result.reasonCode).toBe('PAGE_NOT_READY')
    expect(result.status).toBe('NETWORK_ERROR')
    expect(result.inserted).toBe(0)
  })

  it('登录失效直接停机为 LOGIN_REQUIRED，不调用 Adapter', async () => {
    let called = false
    const service = serviceWith({
      platform: '拼多多', loginStatus: 'LOGIN_REQUIRED',
      adapter: {
        adapterName: 'X', adapterVersion: 'v1', platform: '拼多多', supports: () => true,
        getCapabilities: () => ({ loginDetection: true, orders: false, salesMetrics: true, productSalesMetrics: false, products: false, inventory: false, refunds: false, salesData: false }),
        collectSalesMetrics: () => { called = true; return { status: 'SUCCEEDED' } }
      }
    })
    const result = await service.collect({ storeId: 'store_a', periodType: 'TODAY' })
    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(result.dataStatus).toBe('LOGIN_REQUIRED')
    expect(called).toBe(false)
  })

  it('失败原因码映射到状态机（超时/网络/权限/改版不再一律 ERROR）', () => {
    expect(statusForFailureCode('COLLECTION_TIMEOUT')).toBe('TIMEOUT')
    expect(statusForFailureCode('NETWORK_ERROR')).toBe('NETWORK_ERROR')
    expect(statusForFailureCode('PERMISSION_DENIED')).toBe('PERMISSION_DENIED')
    expect(statusForFailureCode('PAGE_CHANGED')).toBe('PAGE_CHANGED')
    expect(statusForFailureCode('NO_METRICS_FOUND')).toBe('NO_METRICS_FOUND')
    expect(statusForFailureCode('LOGIN_REQUIRED')).toBe('LOGIN_REQUIRED')
    expect(statusForFailureCode('SOMETHING_ELSE')).toBe('ERROR')
  })
})

/* ================================================================== *
 * 16~17. 页面改版不落旧字段 / 未验证来源
 * ================================================================== */

/**
 * 脚本感知的假页面：按注入脚本的形态返回不同结果，模拟真实页面的若干种响应。
 *
 * 真机关键事实（2026-09-28 实测事故）：**点周期控件之前**页面显示的是默认周期的数字
 * （微信首页默认"今天"，成交金额 ¥0），**点完之后**才是目标周期的数字（近7天 ¥108.90）。
 * 因此这里也按"点击是否派发过"切换要返回的数值表；`valuesBeforeClick` 默认与 `values`
 * 相同（= 页面本来就停在目标周期），需要验证"周期切换"的用例必须显式给出两者差异。
 */
function fakePage(options: {
  values?: Record<string, string>
  /** 点周期之前页面上的值（默认与 values 相同 = 无需切换） */
  valuesBeforeClick?: Record<string, string>
  missingLabels?: string[]
  clickable?: boolean
  url?: string
  bodyMatches?: boolean
  /** 正文长度：真机上"外壳"与"渲染完整"分别是 ~107 与 ~2584 字；默认按"已渲染"给 */
  bodyTextLength?: number
  /** 「周期已生效」文案是否出现在页面上（默认出现 = 点击真的生效了） */
  periodAppliedTextSeen?: boolean
  /**
   * 周期控件是否**本来就停在目标周期**（默认 false）。
   * true 表示"点了也没用"的那种页面：SPA 记住了上次选择，再点同一个页签是空操作——
   * 真机实测（2026-09-29）快手就是这样连续 9 次判 PERIOD_NOT_APPLIED 的。
   */
  periodAlreadySelected?: boolean
} = {}): { wc: WebContents; navigated: string[] } {
  const navigated: string[] = []
  let currentUrl = options.url || 'https://store.weixin.qq.com/shop/home'
  const bodyTextLength = options.bodyTextLength ?? 3000
  let clicked = false
  const wc = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => currentUrl,
    loadURL: async (url: string) => { navigated.push(url); currentUrl = url },
    sendInputEvent: () => { clicked = true },
    executeJavaScript: async (code: string) => {
      // 正文长度探针（不把正文带回 Main，只回长度）
      if (code.includes('.innerText || "").length : 0')) return bodyTextLength
      // 「周期已生效」文案探针（含 ShadowRoot 穿透的那条；用 shadowRoot.textContent 作为它的独有特征，
      // 否则会连带命中"找周期控件坐标"的脚本，把点击路径也吞掉）
      if (code.includes('shadowRoot.textContent')) return options.periodAppliedTextSeen !== false
      if (code.includes('new RegExp')) return options.bodyMatches === true
      // 周期控件选中态探针（脚本独有特征 TAB_TEXTS）。**必须排在 __clickableScore 那条之前**：
      // 这条脚本也带 __clickableScore（复用候选排序），否则会被当成"找点击坐标"吞掉。
      if (code.includes('TAB_TEXTS')) {
        const selected = options.periodAlreadySelected === true
        return {
          found: true,
          selected,
          reason: selected ? 'SELECTED_BY_STYLE' : 'SAME_AS_SIBLINGS',
          ownStyle: selected ? 'rgb(50,107,251)|rgb(232,243,255)' : 'rgb(44,46,48)|rgb(245,246,249)',
          siblingStyle: 'rgb(44,46,48)|rgb(245,246,249)'
        }
      }
      if (code.includes('__clickableScore')) return options.clickable === false ? null : { x: 10, y: 10 }
      const label = /const label = ("(?:[^"\\]|\\.)*")/.exec(code)
      if (!label) return { ok: false, reason: 'ERR' }
      const parsed = JSON.parse(label[1]) as string
      if ((options.missingLabels || []).includes(parsed)) { return { ok: false, reason: 'NOT_FOUND' } }
      const table = clicked ? (options.values || {}) : (options.valuesBeforeClick ?? options.values ?? {})
      const value = table[parsed]
      if (value == null) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true, value, cardText: `${parsed} ${value}` }
    }
  } as unknown as WebContents
  return { wc, navigated }
}

function contextFor(wc: WebContents, platform: string, storeId = 'store_a') {
  return {
    storeId, platform, session: {} as never, webContents: wc,
    currentUrl: (() => { try { return wc.getURL() } catch { return '' } })(),
    timeoutMs: 1500
  }
}

const wechat = findPlatform('微信小店')!
const kuaishou = findPlatform('快手小店')!

describe('sales metrics · 页面读取 Adapter', () => {
  it('微信小店：读到成交金额/订单数/退款金额，金额按元转分，周期不符时拒绝落库', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    expect(adapter.getPreferredPeriodType()).toBe('LAST_7_DAYS')
    const { wc } = fakePage({
      values: { 成交金额: '¥1,234.56', 成交订单数: '12', 成交退款金额: '0.00' },
      // 真机同款：默认「今天」视图是 ¥0，点「近7天」后才变成上面的数（这就是周期判据要看的）
      valuesBeforeClick: { 成交金额: '¥0', 成交订单数: '0', 成交退款金额: '0.00' }
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('SUCCEEDED')
    expect(result.sourceType).toBe('DOM')
    expect(result.adapterVersion).toBe('wechat-shop-sales-v1')
    const metric = result.storeMetrics![0]
    expect(metric.grossSalesAmountMinor).toBe(123456)
    expect(metric.paidOrderCount).toBe(12)
    expect(metric.refundAmountMinor).toBe(0)          // 平台明确返回 0
    expect(metric.salesQuantity).toBeNull()           // 档案没登记销量 → null，不是 0
    expect(metric.refundOrderCount).toBeNull()
    expect(metric.netSalesAmountMinor).toBe(123456)   // gross - refund
    expect(metric.periodType).toBe('LAST_7_DAYS')

    // 周期与档案固定口径不一致 → 拒绝按错误口径落库
    const mismatch = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'TODAY', timeoutMs: 1200 })
    expect(mismatch.status).toBe('ERROR')
    expect(mismatch.reasonCode).toBe('PERIOD_SEMANTICS_MISMATCH')
    expect(mismatch.storeMetrics).toEqual([])
  })

  it('点了周期但没生效（值没变、文案也没出现）→ PERIOD_NOT_APPLIED，绝不按目标口径落库', async () => {
    // 2026-09-28 实测事故：微信小店那次点击没生效，页面还停在「今天」（¥0 / 0 单），
    // 采集把这两个数当成「近7天」写了库（真实近7天是 ¥108.90 / 11 单）。
    // 护栏：点完之后值必须变、或出现「较上周期」文案；两样都没有就不采。
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({
      values: { 成交金额: '¥0', 成交订单数: '0', 成交退款金额: '0.00' },
      valuesBeforeClick: { 成交金额: '¥0', 成交订单数: '0', 成交退款金额: '0.00' },
      periodAppliedTextSeen: false
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('ERROR')
    expect(result.reasonCode).toBe('PERIOD_NOT_APPLIED')
    expect(result.dataStatus).toBe('COLLECTION_FAILED')
    expect(result.storeMetrics).toEqual([])
    expect(result.storeMetricsCount).toBe(0)
    expect(result.safeMessage).toContain('周期')
  })

  it('周期生效的两种判据各自够用：只有文案出现（值恰好相同）也算切换成功', async () => {
    // 平台侧可能出现"默认周期与目标周期数值恰好一致"（例如小店只在今天出过单），
    // 此时值不变但「较上周期」文案会出现 —— 不能因为值没变就误判成"周期没生效"。
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({
      values: { 成交金额: '¥888.00', 成交订单数: '3', 成交退款金额: '0.00' },
      valuesBeforeClick: { 成交金额: '¥888.00', 成交订单数: '3', 成交退款金额: '0.00' },
      periodAppliedTextSeen: true
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('SUCCEEDED')
    expect(result.storeMetrics![0].grossSalesAmountMinor).toBe(88800)
  })

  it('页面改版（内容区已渲染但锚点全不命中）→ PAGE_CHANGED 且不写任何字段', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ missingLabels: ['成交金额', '成交订单数', '成交退款金额'], bodyTextLength: 2584 })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('PAGE_CHANGED')
    expect(result.reasonCode).toBe('EVIDENCE_SHAPE_MISMATCH')
    expect(result.dataStatus).toBe('PAGE_CHANGED')
    expect(result.storeMetrics).toEqual([])
    expect(result.storeMetricsCount).toBe(0)
    expect(adapter.verifyEvidence(result, contextFor(wc, '微信小店')).ok).toBe(false)
  })

  it('内容区没渲染（只剩外壳正文）→ 按可重试失败处理，不判"页面改版"', async () => {
    // 真机实测：窗口不在前台时微信/抖店内容区不渲染，外壳正文只有 106～109 字。
    // 这种情况判成 PAGE_CHANGED 会让一个健康平台被永久停采——必须分开。
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ missingLabels: ['成交金额', '成交订单数', '成交退款金额'], bodyTextLength: 107 })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('NETWORK_ERROR')
    expect(result.reasonCode).toBe('PAGE_NOT_RENDERED')
    expect(result.dataStatus).toBe('COLLECTION_FAILED')
    expect(result.storeMetrics).toEqual([])
    // 可重试：状态机不会把它当成"需要用户处理"的停机
    const transition = planTransition({ status: result.status, previousFailures: 0, now: NOW, intervalMs: 600_000, jitterMs: 0 })
    expect(transition.requiresUserAction).toBe(false)
    expect(transition.countsAsFailure).toBe(true)
  })

  it('周期控件点不到（内容区已渲染）→ PAGE_CHANGED（口径无法固定时不采，不按目标周期硬落库）', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ values: { 成交金额: '10' }, clickable: false, bodyTextLength: 2584 })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('PAGE_CHANGED')
    expect(result.reasonCode).toBe('PERIOD_CONTROL_NOT_FOUND')
    expect(result.storeMetrics).toEqual([])
  })

  it('标签在但当前没有数值 → NO_METRICS_FOUND，不写 0 也不写空行', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ values: { 成交金额: '—', 成交订单数: '—', 成交退款金额: '—' } })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('NO_METRICS_FOUND')
    expect(result.dataStatus).toBe('NOT_COLLECTED')
    expect(result.storeMetrics).toEqual([])
  })

  it('部分字段读不到时如实报部分成功，缺的字段保持 null', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ values: { 成交金额: '100', 成交订单数: '3' }, missingLabels: ['成交退款金额'] })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '微信小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('PARTIAL')
    const metric = result.storeMetrics![0]
    expect(metric.grossSalesAmountMinor).toBe(10000)
    expect(metric.refundAmountMinor).toBeNull()
    expect(metric.netSalesAmountMinor).toBeNull()      // 缺算子 → 净销售额为 null
    expect(adapter.verifyEvidence(result, contextFor(wc, '微信小店')).ok).toBe(true)
  })

  it('快手小店：成交件数进销量、退款订单数按档案映射，口径为近7日', async () => {
    const adapter = new KuaishouAdapter(kuaishou)
    expect(adapter.getPreferredPeriodType()).toBe('LAST_7_DAYS')
    const { wc } = fakePage({
      url: 'https://syt.kwaixiaodian.com/zones/goodsManagement/goods_overview',
      values: { 成交金额: '88.8', 成交订单数: '4', 成交件数: '6', '退款金额(退款日)': '1.1', 成交退款订单数: '1' },
      // 真机同款：快手商品总览默认「昨日」（多为 0），点「近7日」后才是有值的近 7 天口径。
      // 这一条同时钉住"周期判据靠值变化"（快手没有可区分的文案标记）
      valuesBeforeClick: { 成交金额: '0', 成交订单数: '0', 成交件数: '0', '退款金额(退款日)': '0', 成交退款订单数: '0' }
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '快手小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('SUCCEEDED')
    const metric = result.storeMetrics![0]
    expect(metric.grossSalesAmountMinor).toBe(8880)
    expect(metric.paidOrderCount).toBe(4)
    expect(metric.salesQuantity).toBe(6)
    expect(metric.refundAmountMinor).toBe(110)
    expect(metric.refundOrderCount).toBe(1)
    expect(metric.orderCount).toBeNull()               // 页面只给一个订单数 → 下单数保持 null
    expect(metric.netSalesAmountMinor).toBe(8770)
  })

  it('页面本来就停在目标周期时不再误报 PERIOD_NOT_APPLIED（判据③：控件自身已选中）', async () => {
    // 2026-09-29 实测：快手计划连续 9 次停采，快照写"点了「近7日」但读数仍是 9.8"——
    // 页面已经停在近7日（SPA 记住上次选择），点同一个页签不会改变任何值，判据①②必然都不成立。
    const adapter = new KuaishouAdapter(kuaishou)
    const same = { 成交金额: '9.8', 成交订单数: '2', 成交件数: '2', '退款金额(退款日)': '0', 成交退款订单数: '0' }
    const { wc } = fakePage({
      values: same,
      valuesBeforeClick: same,          // 点击前后一模一样：模拟"空操作"
      periodAppliedTextSeen: false,     // 快手没有可区分的文案标记
      periodAlreadySelected: true       // 但控件自身显示近7日已选中
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '快手小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('SUCCEEDED')
    expect(result.storeMetrics![0].grossSalesAmountMinor).toBe(980)
  })

  it('控件没显示选中、值也没变时仍然判 PERIOD_NOT_APPLIED（不放松 2026-09-28 的护栏）', async () => {
    const adapter = new KuaishouAdapter(kuaishou)
    const same = { 成交金额: '0', 成交订单数: '0', 成交件数: '0', '退款金额(退款日)': '0', 成交退款订单数: '0' }
    const { wc } = fakePage({
      values: same,
      valuesBeforeClick: same,          // 点击没生效：页面停在默认周期，值不变
      periodAppliedTextSeen: false,
      periodAlreadySelected: false      // 目标页签也没呈现选中态
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '快手小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(result.status).toBe('ERROR')
    expect(result.reasonCode).toBe('PERIOD_NOT_APPLIED')
    expect(result.storeMetrics?.length ?? 0).toBe(0)
  })

  it('不在已登记页面时会先导航过去（而不是拿当前页硬读）', async () => {
    const adapter = new KuaishouAdapter(kuaishou)
    const { wc, navigated } = fakePage({
      url: 'https://syt.kwaixiaodian.com/zones/home',
      values: { 成交金额: '1', 成交订单数: '1', 成交件数: '1', '退款金额(退款日)': '0', 成交退款订单数: '0' },
      // 默认「昨日」视图（0）→ 点「近7日」后有值：与真机一致，也让周期判据通过
      valuesBeforeClick: { 成交金额: '0', 成交订单数: '0', 成交件数: '0', '退款金额(退款日)': '0', 成交退款订单数: '0' }
    })
    const result = await adapter.collectSalesMetrics(contextFor(wc, '快手小店'), { periodType: 'LAST_7_DAYS', timeoutMs: 1200 })
    expect(navigated).toEqual([businessProfileFor('快手小店')!.pageUrl])
    expect(result.status).toBe('SUCCEEDED')
  })

  it('登录过期文案命中时返回 LOGIN_REQUIRED（不返回 LOGGED_IN）', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ bodyMatches: true })
    const login = await adapter.detectLoginStatus(contextFor(wc, '微信小店'))
    expect(login.status).toBe('LOGIN_REQUIRED')
    expect(login.evidenceType).toBe('DOM')
  })

  it('其它 host 不认，返回 UNKNOWN 而不是 LOGGED_IN', async () => {
    const adapter = new WeChatShopAdapter(wechat)
    const { wc } = fakePage({ url: 'https://example.com/shop/home' })
    const login = await adapter.detectLoginStatus(contextFor(wc, '微信小店'))
    expect(login.status).toBe('UNKNOWN')
    expect(login.reasonCode).toBe('PAGE_NOT_RECOGNIZED')
  })

  it('四个平台各自独立注册，能力声明不跨平台套用', () => {
    const registry = new PlatformAdapterRegistry([new WeChatShopAdapter(wechat), new KuaishouAdapter(kuaishou)])
    expect(registry.supports('微信小店')).toBe(true)
    expect(registry.resolveAdapter('快手小店')).not.toBeNull()
    expect(registry.resolveAdapter('抖店')).toBeNull()
    // 三个已实测平台都声明了经营数据能力，但没有一个声明订单能力
    expect(registry.getAdapter('微信小店').getCapabilities()).toMatchObject({ salesMetrics: true, orders: false })
    expect(registry.getAdapter('快手小店').getCapabilities()).toMatchObject({ salesMetrics: true, orders: false })
  })
})

/* ================================================================== *
 * 视图与健康汇总
 * ================================================================== */

describe('sales metrics · 计划视图与健康汇总', () => {
  realIt('视图把计划、店铺名、指标与新鲜度合成一条；从未采集的店铺状态是 UNAVAILABLE', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '微信小店')
    seedStore(db, 'store_b', 'B 店', '拼多多')
    syncOnce(ledger, [makeStoreRow('store_a', '微信小店'), makeStoreRow('store_b', '拼多多')], NOW, true)
    db.prepare('UPDATE sales_collection_plans SET last_success_at = ?, last_status = ? WHERE store_id = ?').run(NOW - 60_000, 'SUCCEEDED', 'store_a')

    const views = ledger.listPlanViews(NOW)
    const a = views.find(view => view.storeId === 'store_a')!
    const b = views.find(view => view.storeId === 'store_b')!
    expect(a.storeName).toBe('A 店')
    expect(a.freshness).toBe('FRESH')
    expect(a.metrics).toBeNull()
    expect(a.dataStatus).toBe('NOT_COLLECTED')   // 有状态但还没写过指标 → 未采集，而不是真实 0
    expect(a.trend).toEqual([])
    expect(b.freshness).toBe('UNAVAILABLE')
    expect(b.lastStatus).toBe('READY')

    const health = ledger.health(NOW, views)
    expect(health.counters.total).toBe(2)
    expect(health.counters.enabled).toBe(2)
    expect(health.counters.fresh).toBe(1)
    expect(health.counters.unavailable).toBe(1)
    expect(health.nextRunAt).not.toBeNull()
  })

  realIt('需要用户处理的状态进入 attention 列表（前端据此提示重新登录）', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '抖店')
    syncOnce(ledger, [makeStoreRow('store_a', '抖店')], NOW, true)
    db.prepare('UPDATE sales_collection_plans SET last_status = ?, last_reason_code = ? WHERE store_id = ?').run('LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'store_a')
    const views = ledger.listPlanViews(NOW)
    const health = ledger.health(NOW, views)
    expect(health.counters.requiresUserAction).toBe(1)
    expect(health.attention[0]).toMatchObject({ storeId: 'store_a', status: 'LOGIN_REQUIRED' })
  })

  realIt('数据源未验证的店铺进入 attention 但不计入失败（不是系统故障）', () => {
    const { db, ledger } = setup()
    seedStore(db, 'store_a', 'A 店', '拼多多')
    syncOnce(ledger, [makeStoreRow('store_a', '拼多多')], NOW, true)
    db.prepare('UPDATE sales_collection_plans SET last_status = ? WHERE store_id = ?').run('DATA_SOURCE_NOT_VERIFIED', 'store_a')
    db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, status, created_at) VALUES ('r1','store_a','拼多多',?, 'DATA_SOURCE_NOT_VERIFIED', ?)`).run(NOW, NOW)
    const health = ledger.health(NOW, ledger.listPlanViews(NOW))
    expect(health.counters.failuresLast24h).toBe(0)
    expect(health.counters.successesLast24h).toBe(1)
    expect(health.counters.sourceUnverified).toBe(1)
    expect(health.attention.map(item => item.storeId)).toContain('store_a')
  })
})
