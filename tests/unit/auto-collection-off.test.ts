/**
 * 「自动采集总开关关闭时，绝不允许自己跑」的回归测试（2026-10-04 用户要求改为手动）。
 *
 * 覆盖三条真实通道：
 *   ① 销售采集计划：新店不再自动建"启用"的计划；已启用的计划被停掉（原因码 AUTO_COLLECTION_OFF）
 *   ② 手动采集不受影响：用户点「立即采集」照常跑（这是"以后改为手动"的落点）
 *   ③ 打开开关后恢复原来的周期采集行为
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { SalesMetricsLedger } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-ledger'
import {
  requestImmediateRun,
  resetSalesMetricsSchedulerForTests,
  setSalesMetricsSchedulerRuntimeForTests,
  stopSalesMetricsScheduler,
  tickSalesMetricsScheduler,
  type SalesMetricsSchedulerRuntime
} from '../../apps/desktop/src/main/sales-metrics/sales-metrics-scheduler'
import type { SalesMetricsCollectionResult } from '@shared/contracts/sales-metrics'

type SqliteCtor = new (path: string) => { exec(sql: string): void; prepare(sql: string): any; close(): void }

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch { return null }
}

const Sqlite = loadSqlite()
const describeIfSqlite = Sqlite ? describe : describe.skip
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0)
const INTERVAL = 600_000
/** 计划同步的节流：模块内 30 秒才同步一次，测试里必须把时钟推过去 */
const SYNC_STEP = 31_000

function result(storeId: string): SalesMetricsCollectionResult {
  return {
    storeId, platform: '拼多多', status: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW,
    periodStart: null, periodEnd: null, storeMetricsCount: 1, productMetricsCount: 0,
    inserted: 1, updated: 0, skipped: 0, failed: 0, sourceType: 'DOM', reasonCode: null,
    safeMessage: null, adapterVersion: 'v1', metricDefinitionVersion: 'sales-metrics-1',
    sourceUpdatedAt: null, dataStatus: 'REAL_VALUE', evidence: null
  }
}

// 每个 harness 用一个更晚的起点：lastPlanSyncAt 是模块级状态，跨用例不会自动清零，
// 时间不往前走的话「计划同步」会被 30 秒节流挡住，用例会以「计划没建出来」的形式假失败。
let harnessSeq = 0
/** 最小运行环境：真库 + 假采集 + 可切换的总开关 + 可推进的时钟 */
function harness(autoEnabled: boolean) {
  const raw = new (Sqlite as SqliteCtor)(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  // node:sqlite 没有 better-sqlite3 的 transaction()：按迁移与台账的用法补一层
  const shim = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      raw.exec('BEGIN')
      try { const value = fn(...args); raw.exec('COMMIT'); return value } catch (error) { raw.exec('ROLLBACK'); throw error }
    }
  }
  const db = shim as unknown as Database.Database
  migrate(db as any)
  const ledger = new SalesMetricsLedger(db)
  const collectCalls: string[] = []
  const clock = { value: NOW + (++harnessSeq) * 86_400_000 }
  const runtime: SalesMetricsSchedulerRuntime = {
    now: () => clock.value,
    ledger,
    collect: async input => { collectCalls.push(input.storeId); return result(input.storeId) },
    listStores: () => [{ id: 'store_a', platform: '拼多多' }],
    emit: () => {},
    autoCollectionEnabled: () => autoEnabled
  }
  /** 推进时钟并拍一拍（跨过计划同步节流） */
  const beat = async (advanceMs = SYNC_STEP) => {
    clock.value += advanceMs
    tickSalesMetricsScheduler()
    await vi.advanceTimersByTimeAsync(300)
  }
  return { db, ledger, runtime, collectCalls, clock, beat }
}

/** 建一家店（计划同步只认活跃店铺） */
function insertStore(db: Database.Database, at: number): void {
  db.prepare(`INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, sort_order, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, '', 'online', '#fff', 0, '[]', ?, ?)`).run('store_a', '测试店', '拼多多', at, at)
}

describeIfSqlite('自动采集总开关（改为手动）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    resetSalesMetricsSchedulerForTests()
    stopSalesMetricsScheduler({ markInterrupted: false })
    vi.useRealTimers()
  })

  it('关闭时：新店铺的计划建出来是"停用"的，不会自己跑', async () => {
    const h = harness(false)
    insertStore(h.db, h.clock.value)
    setSalesMetricsSchedulerRuntimeForTests(() => h.runtime)
    await h.beat()
    const plan = h.ledger.getPlan('store_a')
    expect(plan).toBeTruthy()
    expect(plan!.enabled).toBe(false)
    expect(plan!.nextRunAt).toBeNull()
    // 就算把计划强行改成"早就该跑"，也不许跑，而且会被这一拍重新停掉
    h.db.prepare('UPDATE sales_collection_plans SET enabled = 1, next_run_at = ? WHERE store_id = ?').run(h.clock.value - 1, 'store_a')
    await h.beat()
    expect(h.collectCalls).toEqual([])
    const after = h.ledger.getPlan('store_a')
    expect(after!.enabled).toBe(false)
    expect(after!.nextRunAt).toBeNull()
  })

  it('关闭时：已启用（历史遗留）的计划会被停掉', async () => {
    const h = harness(false)
    insertStore(h.db, h.clock.value)
    h.ledger.ensurePlan({ storeId: 'store_a', platform: '拼多多', now: NOW, intervalMs: INTERVAL, jitterMs: 0, autoEnabled: true })
    expect(h.ledger.getPlan('store_a')!.enabled).toBe(true)
    setSalesMetricsSchedulerRuntimeForTests(() => h.runtime)
    await h.beat()
    const plan = h.ledger.getPlan('store_a')
    expect(plan!.enabled).toBe(false)
    expect(plan!.nextRunAt).toBeNull()
  })

  it('关闭时：手动补位建的计划也不会偷偷纳入自动采集', () => {
    const h = harness(false)
    insertStore(h.db, h.clock.value)
    h.ledger.ensurePlan({ storeId: 'store_a', platform: '拼多多', now: NOW, intervalMs: INTERVAL, jitterMs: 0, autoEnabled: false })
    const plan = h.ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(false)
    expect(plan.nextRunAt).toBeNull()
  })

  it('关闭时：用户点「立即采集」照常跑（手动不受影响）', async () => {
    const h = harness(false)
    insertStore(h.db, h.clock.value)
    setSalesMetricsSchedulerRuntimeForTests(() => h.runtime)
    await h.beat() // 先把计划同步出来（停用状态）
    const queued = requestImmediateRun('store_a')
    expect(queued.queued).toBe(true)
    await h.beat(1000)
    expect(h.collectCalls).toEqual(['store_a'])
  })

  it('打开时：恢复周期采集（新店直接是启用计划，到点自己跑）', async () => {
    const h = harness(true)
    insertStore(h.db, h.clock.value)
    setSalesMetricsSchedulerRuntimeForTests(() => h.runtime)
    await h.beat()
    const plan = h.ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(true)
    expect(plan.nextRunAt).toBeGreaterThan(h.clock.value)
    await h.beat(INTERVAL * 2)
    expect(h.collectCalls).toEqual(['store_a'])
  })
})
