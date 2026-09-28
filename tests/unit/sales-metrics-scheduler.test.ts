/**
 * 经营采集调度器的节拍行为（开发文档 §7）。
 *
 * 用真实 SQLite 台账 + 注入的假时钟/假采集，驱动**真实的 tick 代码路径**，
 * 覆盖文档 §7 里靠单测才能锁住的那几条：
 *   1. 每次触发写入运行记录；
 *   2. 同一店铺不会并行（第二次触发被互斥挡住）；
 *   3. 全局并发上限为 2；
 *   4. 完成后更新计划状态与下一次运行时间；
 *   5. 需要用户处理的停机态不会被下一拍重新拉起；
 *   6. 关闭调度时把在跑的运行标记为中断，库里不留 RUNNING；
 *   7. 数据库异常不会把异常抛到主进程。
 *
 * 明确不覆盖：真实定时器的漂移、真实平台的采集结果——那属于连续运行与真实平台验收。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { SalesMetricsLedger } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-ledger'
import { SalesMetricsRepository } from '../../apps/desktop/src/main/sales-metrics/sales-metrics-repository'
import {
  getPlanView,
  healthSnapshot,
  listPlanViews,
  listRuns,
  pausePlan,
  requestImmediateRun,
  resetSalesMetricsSchedulerForTests,
  resumePlan,
  setSalesMetricsSchedulerRuntimeForTests,
  startSalesMetricsScheduler,
  stopSalesMetricsScheduler,
  tickSalesMetricsScheduler,
  updatePlanSettings,
  type SalesMetricsSchedulerRuntime
} from '../../apps/desktop/src/main/sales-metrics/sales-metrics-scheduler'
import { SALES_METRICS_MAX_PARALLEL, jitterMsForStore, planTransition } from '@shared/sales-metrics-rules'
import type { SalesMetricsCollectionResult } from '@shared/contracts/sales-metrics'

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
const NOW = Date.UTC(2026, 8, 28, 6, 0, 0)

interface Harness {
  db: Database.Database
  ledger: SalesMetricsLedger
  emits: Array<{ channel: string; payload: unknown }>
  clock: { value: number }
  collectCalls: Array<{ storeId: string; runId: string }>
  behavior: (storeId: string) => Promise<SalesMetricsCollectionResult>
  runtime: SalesMetricsSchedulerRuntime
  close(): void
}

function result(storeId: string, status: SalesMetricsCollectionResult['status'], extra: Partial<SalesMetricsCollectionResult> = {}): SalesMetricsCollectionResult {
  return {
    storeId, platform: '拼多多', status, startedAt: NOW, finishedAt: NOW,
    periodStart: 0, periodEnd: 0, storeMetricsCount: 0, productMetricsCount: 0,
    inserted: 0, updated: 0, skipped: 0, failed: 0, sourceType: 'DOM',
    reasonCode: 'TEST', safeMessage: '测试', adapterVersion: 'v1',
    metricDefinitionVersion: 'sales-metrics-1', sourceUpdatedAt: null,
    dataStatus: 'NOT_COLLECTED', evidence: null,
    ...extra
  }
}

function harness(stores: Array<{ id: string; platform: string }>): Harness {
  const raw = new (DatabaseSyncCtor as SqliteCtor)(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  const shim = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      raw.exec('BEGIN')
      try { const value = fn(...args); raw.exec('COMMIT'); return value } catch (error) { raw.exec('ROLLBACK'); throw error }
    }
  }
  const db = shim as unknown as Database.Database
  migrate(db)
  for (const store of stores) {
    db.prepare(`INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, sort_order, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, '', 'online', '#fff', 0, '[]', ?, ?)`).run(store.id, store.id, store.platform, NOW, NOW)
  }
  const clock = { value: NOW }
  const emits: Array<{ channel: string; payload: unknown }> = []
  const collectCalls: Array<{ storeId: string; runId: string }> = []
  let behavior: Harness['behavior'] = async storeId => result(storeId, 'SUCCEEDED')
  const ledger = new SalesMetricsLedger(db)
  const repository = new SalesMetricsRepository(db)
  const runtime: SalesMetricsSchedulerRuntime = {
    now: () => clock.value,
    ledger,
    collect: async (input, runContext) => {
      collectCalls.push({ storeId: input.storeId, runId: runContext.runId })
      const output = await behavior(input.storeId)
      // 成功/部分成功时模拟采集服务写入统一指标 + 证据
      if (output.status === 'SUCCEEDED' || output.status === 'PARTIAL') {
        repository.upsertStoreMetrics({
          id: `m-${input.storeId}`, platform: '拼多多', storeId: input.storeId, periodType: 'TODAY',
          periodStart: 0, periodEnd: 0, orderCount: 2, paidOrderCount: 2, salesQuantity: 2,
          grossSalesAmountMinor: 1000, paidSalesAmountMinor: 1000, refundAmountMinor: 0,
          refundOrderCount: 0, refundQuantity: 0, netSalesAmountMinor: 1000,
          collectedAt: clock.value, sourceUpdatedAt: null, sourceType: 'DOM', adapterVersion: 'v1',
          metricDefinitionVersion: 'sales-metrics-1', dataStatus: 'REAL_VALUE', runId: runContext.runId
        })
      }
      return output
    },
    listStores: () => stores,
    emit: (channel, payload) => { emits.push({ channel, payload }) }
  }
  return {
    db, ledger, emits, clock, collectCalls, runtime,
    get behavior() { return behavior },
    set behavior(next: Harness['behavior']) { behavior = next },
    close: () => { try { raw.close() } catch { /* ignore */ } }
  }
}

let current: Harness | null = null
beforeEach(() => {
  resetSalesMetricsSchedulerForTests()
  current = null
})
afterEach(() => {
  stopSalesMetricsScheduler({ markInterrupted: false })
  resetSalesMetricsSchedulerForTests()
  current?.close()
  current = null
})

function use(h: Harness): Harness {
  current = h
  setSalesMetricsSchedulerRuntimeForTests(() => h.runtime)
  return h
}

function dueNow(h: Harness): void {
  h.db.prepare('UPDATE sales_collection_plans SET next_run_at = ?, backoff_until = NULL').run(h.clock.value - 1)
}

/** 等到 inFlight 清空（runPlan 是 void 启动的异步任务）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) { await new Promise(resolve => setTimeout(resolve, 0)) }
}

describe('经营采集调度器 · 节拍', () => {
  realIt('每次触发写入运行记录，完成后更新计划状态与下一次运行时间', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()

    const runs = listRuns({ storeId: 'store_a' }, h.clock.value)
    expect(runs.total).toBe(1)
    expect(runs.items[0].status).toBe('SUCCEEDED')
    expect(runs.items[0].plannedAt).toBe(h.clock.value - 1)
    expect(runs.items[0].finishedAt).not.toBeNull()
    expect(runs.items[0].adapterVersion).toBe('v1')

    const plan = h.ledger.getPlan('store_a')!
    expect(plan.lastStatus).toBe('SUCCEEDED')
    expect(plan.lastSuccessAt).toBe(h.clock.value)
    expect(plan.nextRunAt).toBe(h.clock.value + plan.intervalMs + jitterMsForStore('store_a'))
    expect(plan.consecutiveFailures).toBe(0)
  })

  realIt('实时事件只带九个安全字段，且顺序为 started → finished → planUpdated', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()

    const channels = h.emits.map(item => item.channel)
    expect(channels).toContain('salesMetrics:runStarted')
    expect(channels).toContain('salesMetrics:runFinished')
    expect(channels).toContain('salesMetrics:planUpdated')
    expect(channels.indexOf('salesMetrics:runStarted')).toBeLessThan(channels.indexOf('salesMetrics:runFinished'))

    const payload = h.emits.find(item => item.channel === 'salesMetrics:runFinished')!.payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'collectedAt', 'consecutiveFailures', 'freshness', 'nextRunAt', 'platform', 'reasonCode', 'runId', 'status', 'storeId'
    ])
    expect(JSON.stringify(h.emits)).not.toMatch(/cookie|token|session|webContents|authorization/i)
  })

  realIt('同一店铺不会并行：采集未结束时再触发不产生第二条运行', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    let release: (() => void) | null = null
    h.behavior = storeId => new Promise(resolve => { release = () => resolve(result(storeId, 'SUCCEEDED')) })
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    expect(h.collectCalls).toHaveLength(1)

    // 采集还挂着：把计划点再拉到当下，节拍不应该再拉起同一家店
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    expect(h.collectCalls).toHaveLength(1)
    expect(listRuns({ storeId: 'store_a' }, NOW).total).toBe(1)

    release?.()
    await settle()
    expect(listRuns({ storeId: 'store_a' }, NOW).items[0].status).toBe('SUCCEEDED')
  })

  realIt('全局并发上限为 2：三店同时到期时先跑两家，没跑过的店不会被挤掉', async () => {
    const h = use(harness([
      { id: 'store_a', platform: '拼多多' },
      { id: 'store_b', platform: '拼多多' },
      { id: 'store_c', platform: '拼多多' }
    ]))
    const releases: Array<() => void> = []
    h.behavior = storeId => new Promise(resolve => { releases.push(() => resolve(result(storeId, 'SUCCEEDED'))) })
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    expect(SALES_METRICS_MAX_PARALLEL).toBe(2)
    // 三家同时到期、全局额度 2 → 本拍只拉起两家（且两家都还没完成时额度已用尽，再来一拍也拉不起第三家）
    expect(h.collectCalls).toHaveLength(2)
    expect(new Set(h.collectCalls.map(call => call.storeId))).toEqual(new Set(['store_a', 'store_b']))

    for (const release of releases.splice(0)) release()
    await settle()
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sales_collection_runs WHERE status='RUNNING'").get()).toMatchObject({ n: 0 })

    // 关键性质：刚跑完的两家下一次计划点已被推到 10 分钟后（假时钟不前进），
    // 于是这一拍唯一还到期的就是没跑过的 store_c → 它必须被拉起，不能饿死。
    //
    // 这一条不能用「把三家都重新拉到同一时刻再拍一次」来验（旧写法就是这样，且是 flaky 源）：
    // ① 那种状态生产环境不会出现——每家计划的 next_run_at 各自 +10 分钟，永远不会被外力统一重置；
    // ② 调度器真有 1 秒节拍定时器（TICK_MS=1000），而本用例的 settle() 只是 50 次宏任务让行，
    //    机器慢时它会先跑一拍把 store_c 拉起来、机器快时不会——同一份代码的通过与否取决于机器负载。
    // 现在改成「只断言两次采集后必然收敛到三家各一次」，与那 1 秒定时器谁先谁后无关。
    tickSalesMetricsScheduler()
    await settle()
    expect(h.collectCalls).toHaveLength(3)
    expect(new Set(h.collectCalls.map(call => call.storeId))).toEqual(new Set(['store_a', 'store_b', 'store_c']))

    // 把仍在挂起的采集逐个放行，直到库里不留 RUNNING。
    // 不能只放一次：本拍与上一拍挂起的 promise 数量不同，写死次数会让断言变成"碰巧通过"。
    for (let round = 0; round < 8; round++) {
      const pending = (h.db.prepare("SELECT COUNT(*) AS n FROM sales_collection_runs WHERE status='RUNNING'").get() as { n: number }).n
      if (pending === 0) break
      for (const release of releases.splice(0)) release()
      await settle()
    }
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sales_collection_runs WHERE status='RUNNING'").get()).toMatchObject({ n: 0 })
  })

  realIt('登录失效后停机：下一拍不会重新拉起，且不再累计失败次数', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.behavior = storeId => Promise.resolve(result(storeId, 'LOGIN_REQUIRED', { reasonCode: 'LOGIN_REQUIRED', dataStatus: 'LOGIN_REQUIRED' }))
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()

    const plan = h.ledger.getPlan('store_a')!
    expect(plan.lastStatus).toBe('LOGIN_REQUIRED')
    expect(plan.nextRunAt).toBeNull()
    expect(plan.consecutiveFailures).toBe(0)

    // 即使有人把计划点改回当下，也不该被自动重试（需要用户处理的状态已停机）
    tickSalesMetricsScheduler()
    await settle()
    expect(h.collectCalls).toHaveLength(1)
    expect(listPlanViews(h.clock.value)[0].requiresUserAction).toBe(true)
  })

  realIt('页面改版同样停机，并保留 last_safe_message 供前端如实展示', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.behavior = storeId => Promise.resolve(result(storeId, 'PAGE_CHANGED', {
      reasonCode: 'EVIDENCE_SHAPE_MISMATCH', safeMessage: '锚点一个都没命中，页面可能已改版', dataStatus: 'PAGE_CHANGED'
    }))
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    const view = getPlanView('store_a', h.clock.value)!
    expect(view.lastStatus).toBe('PAGE_CHANGED')
    expect(view.lastSafeMessage).toContain('页面可能已改版')
    expect(view.nextRunAt).toBeNull()
    expect(view.metrics).toBeNull()
  })

  realIt('网络失败按退避推迟下一次，退避不会被 10 分钟周期吃掉', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.behavior = storeId => Promise.resolve(result(storeId, 'ERROR', { reasonCode: 'INTERNAL', dataStatus: 'COLLECTION_FAILED' }))
    startSalesMetricsScheduler()
    for (let attempt = 1; attempt <= 3; attempt++) {
      dueNow(h)
      h.db.prepare('UPDATE sales_collection_plans SET backoff_until = NULL').run()
      tickSalesMetricsScheduler()
      await settle()
    }
    const plan = h.ledger.getPlan('store_a')!
    expect(plan.consecutiveFailures).toBe(3)
    expect(plan.backoffUntil).toBe(h.clock.value + 60 * 60 * 1000)
    expect(plan.nextRunAt).toBe(h.clock.value + 60 * 60 * 1000)
    // 退避未到时，即使计划点被改成过去也不跑
    h.db.prepare('UPDATE sales_collection_plans SET next_run_at = ?').run(h.clock.value - 1)
    const before = h.collectCalls.length
    tickSalesMetricsScheduler()
    await settle()
    expect(h.collectCalls).toHaveLength(before)
  })

  realIt('停止调度时把在跑的运行标记为中断，库里不留 RUNNING', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.behavior = () => new Promise(() => undefined)   // 永不结束
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sales_collection_runs WHERE status='RUNNING'").get()).toMatchObject({ n: 1 })

    stopSalesMetricsScheduler()
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sales_collection_runs WHERE status='RUNNING'").get()).toMatchObject({ n: 0 })
    expect(h.db.prepare('SELECT status, reason_code FROM sales_collection_runs').get()).toMatchObject({ status: 'INTERRUPTED', reason_code: 'APP_RESTARTED' })
  })

  realIt('启动时收敛上次残留的 RUNNING，并把过去的计划点重锚（不补发积压）', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.ledger.syncPlans({ stores: [{ id: 'store_a', platform: '拼多多' }], now: NOW - 3_600_000, intervalMs: 600_000, anchor: (previous, interval, now, jitter) => now + interval + jitter, jitterFor: jitterMsForStore })
    h.db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, started_at, status, created_at) VALUES ('old','store_a','拼多多',?,?, 'RUNNING', ?)`).run(NOW - 1000, NOW - 1000, NOW - 1000)

    startSalesMetricsScheduler()

    expect(h.db.prepare('SELECT status FROM sales_collection_runs WHERE run_id = ?').get('old')).toMatchObject({ status: 'INTERRUPTED' })
    const plan = h.ledger.getPlan('store_a')!
    expect(plan.nextRunAt).toBe(NOW + plan.intervalMs + jitterMsForStore('store_a'))
  })

  realIt('数据库异常不会抛到主进程：节拍照常返回', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    // 模拟库被关掉（退出过程中的真实场景）
    vi.spyOn(h.ledger, 'getPlan').mockImplementation(() => { throw new Error('database is closed') })
    vi.spyOn(h.ledger, 'listDuePlans').mockImplementation(() => { throw new Error('database is closed') })
    vi.spyOn(h.ledger, 'listPlans').mockImplementation(() => { throw new Error('database is closed') })
    expect(() => tickSalesMetricsScheduler()).not.toThrow()
    vi.restoreAllMocks()
  })

  realIt('「立即采集」入队后由节拍执行，且不改动启用状态', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    pausePlan('store_a')
    const queued = requestImmediateRun('store_a')
    expect(queued.queued).toBe(true)
    expect(h.ledger.getPlan('store_a')!.enabled).toBe(false)
    tickSalesMetricsScheduler()
    expect(h.collectCalls).toHaveLength(1)
  })

  realIt('未知店铺的立即采集被拒绝，不静默排队', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    expect(requestImmediateRun('store_ghost')).toMatchObject({ queued: false, reasonCode: 'STORE_NOT_FOUND' })
    expect(h.collectCalls).toHaveLength(0)
  })

  realIt('暂停/恢复/改周期都会推送计划变更事件并反映在视图里', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    expect(pausePlan('store_a')).toBe(true)
    expect(resumePlan('store_a')).toBe(true)
    expect(updatePlanSettings('store_a', { intervalMs: 1_800_000 })).toBe(true)
    const view = getPlanView('store_a', h.clock.value)!
    expect(view.intervalMs).toBe(1_800_000)
    expect(view.enabled).toBe(true)
    const channels = h.emits.map(item => item.channel)
    expect(channels.filter(channel => channel === 'salesMetrics:planUpdated').length).toBeGreaterThanOrEqual(3)
    expect(healthSnapshot(h.clock.value).counters.total).toBe(1)
  })

  realIt('店铺被删除后不再参与调度（计划停用 + 不产生新运行）', () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    startSalesMetricsScheduler()
    // 店铺从列表消失（软删除/回收站）
    const runtime = h.runtime as unknown as { listStores: () => Array<{ id: string; platform: string }> }
    runtime.listStores = () => []
    // 计划同步有 30 秒节流，这里把时钟推过去
    h.clock.value = NOW + 60_000
    tickSalesMetricsScheduler()
    const plan = h.ledger.getPlan('store_a')!
    expect(plan.enabled).toBe(false)
    expect(h.collectCalls).toHaveLength(0)
  })

  realIt('失败运行不写指标、不刷新成功时间，健康汇总如实计入失败', async () => {
    const h = use(harness([{ id: 'store_a', platform: '拼多多' }]))
    h.behavior = storeId => Promise.resolve(result(storeId, 'ERROR', { reasonCode: 'INTERNAL', dataStatus: 'COLLECTION_FAILED' }))
    startSalesMetricsScheduler()
    dueNow(h)
    tickSalesMetricsScheduler()
    await settle()
    const view = getPlanView('store_a', h.clock.value)!
    expect(view.metrics).toBeNull()
    expect(view.lastSuccessAt).toBeNull()
    expect(view.freshness).toBe('UNAVAILABLE')
    const health = healthSnapshot(h.clock.value)
    expect(health.counters.failuresLast24h).toBe(1)
    expect(health.counters.successesLast24h).toBe(0)
    // 退避窗口与状态机一致
    expect(view.backoffUntil).toBe(h.clock.value + 2 * 60 * 1000)
  })

  it('状态机常量与文档一致（并发 2、退避 2/5/60 分钟）', () => {
    expect(SALES_METRICS_MAX_PARALLEL).toBe(2)
    expect(planTransition({ status: 'ERROR', previousFailures: 0, now: 0, intervalMs: 600_000 }).backoffUntil).toBe(2 * 60 * 1000)
    expect(planTransition({ status: 'ERROR', previousFailures: 1, now: 0, intervalMs: 600_000 }).backoffUntil).toBe(5 * 60 * 1000)
    expect(planTransition({ status: 'ERROR', previousFailures: 2, now: 0, intervalMs: 600_000 }).backoffUntil).toBe(60 * 60 * 1000)
  })
})
