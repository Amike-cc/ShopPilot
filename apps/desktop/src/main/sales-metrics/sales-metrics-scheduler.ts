/**
 * 经营数据自动采集调度（开发文档 §7/§8）。
 *
 * 与通用 TaskScheduler 分开：经营指标是只读、按店铺独立、允许失败退避的长驻采集，
 * 不应进入需要人工确认的通用任务队列。
 *
 * 这一层只负责四件事，把它们放在一处才能保证状态一致：
 *   1. **计划**：新店铺自动建计划、消失的店铺停计划、重启不补发停机期间的积压（§7.4）。
 *   2. **互斥与并发**：同一店铺绝不并行；全局最多 `SALES_METRICS_MAX_PARALLEL` 家同时跑。
 *   3. **退避与熔断**：失败按 2/5/60 分钟退避，连续失败到阈值熔断；需要用户处理的
 *      状态（登录/验证/权限/页面改版）停机等待，不做无意义重试（§8）。
 *   4. **台账与事件**：每次触发写运行记录，每次完成更新计划并推送实时事件（§7.12/§10）。
 *
 * 所有数据库访问都在 try/catch 内：库被关掉（退出过程中）或磁盘异常都不能让主进程崩溃（§7.10）。
 */
import type Database from 'better-sqlite3'
import { getDatabase } from '../db/database'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type {
  SalesMetricsCollectionResult,
  SalesMetricsCollectionStatus,
  SalesMetricsFreshness,
  SalesMetricsPlanView
} from '@shared/contracts/sales-metrics'
import {
  SALES_METRICS_DEFAULT_INTERVAL_MS,
  SALES_METRICS_MAX_PARALLEL,
  anchorNextRun,
  computeFreshness,
  jitterMsForStore,
  planTransition
} from '@shared/sales-metrics-rules'
import * as StoreManager from '../stores/store-manager'
import { businessProfileFor } from '@shared/constants/business'
import { emitToRenderer } from '../browser/window-manager'
import { logMain } from '../services/logger'
import { isAutoCollectionEnabled } from '../services/collection-mode'
import { salesMetricsCollectionService } from './sales-metrics-collection-service'
import { SalesMetricsLedger } from './sales-metrics-ledger'

/** 默认周期：10 分钟。保留旧名以兼容既有引用。 */
export const SALES_METRICS_INTERVAL_MS = SALES_METRICS_DEFAULT_INTERVAL_MS
const TICK_MS = 1000
/** 计划同步（新店铺/删店铺）的节流：没必要每秒扫一次计划表。 */
const PLAN_SYNC_INTERVAL_MS = 30 * 1000
/** 单次采集的硬上限：Adapter 内部的预算之外再加一层，避免脚本挂死把唯一并发位占住。
 *  取 180 秒是因为真机上微信小店的经营数据区要 30 秒以上才渲染完（实测），
 *  90 秒的 Adapter 预算留一倍余量。 */
const RUN_HARD_TIMEOUT_MS = 180 * 1000
/**
 * 交给 Adapter 的预算：导航 + 固定周期 + 逐指标读值都在这个预算内完成。
 *
 * 120 秒（原 90 秒）是因为一次采集现在可能要采**多个口径**（主口径 + 档案声明的附加口径，
 * 如快手/微信还要补采近 30 天）：每个口径都要"点页签 → 验证切换生效 → 等页面重取数 → 读锚点"，
 * 微信小店单个口径就要 10 秒上下。预算不够时附加口径会被跳过（如实记为部分成功），
 * 所以这里给足；硬上限仍是 180 秒，卡死也不会占住唯一的并发位。
 */
const RUN_ADAPTER_BUDGET_MS = 120 * 1000
/**
 * 手动"立即采集"时的并发上限（用户正盯着看，值得多开两个位）。
 *
 * 周期采集按 2 家保守跑：没人等，撞上平台限速也只是下一轮再采。
 * 但"刷新数据"是用户按下的，四家店串行两两排队要等一分多钟——所以手动队列非空时放宽到 4
 * （每家是各自独立的 store 分区与页面，资源上就是一个浏览器开四个后台标签页）。
 */
const MANUAL_MAX_PARALLEL = 4

export interface SalesMetricsSchedulerRuntime {
  now: () => number
  ledger: SalesMetricsLedger
  /**
   * 采集一次。**不传周期**：周期由平台档案决定（各平台页面固定住的周期不同），
   * 由采集服务向 Adapter 询问，调度器不替平台决定口径。
   */
  collect: (input: { storeId: string; timeoutMs: number }, runContext: { runId: string }) => Promise<SalesMetricsCollectionResult>
  listStores: () => Array<{ id: string; platform: string }>
  emit: (channel: string, payload: unknown) => void
  /**
   * 自动采集总开关（2026-10-04）。缺省读 app_settings 的 collection.autoEnabled（默认关）。
   * 单测里注入，就能在不碰数据库的情况下分别验证"自动"和"手动"两条路。
   */
  autoCollectionEnabled?: () => boolean
}

function defaultRuntime(): SalesMetricsSchedulerRuntime {
  const database = getDatabase()
  return {
    now: () => Date.now(),
    ledger: new SalesMetricsLedger(database as Database.Database),
    collect: (input, runContext) => salesMetricsCollectionService.collect(input, runContext),
    listStores: () => StoreManager.listStores().map(store => ({ id: store.id, platform: store.platform })),
    emit: emitToRenderer,
    autoCollectionEnabled: isAutoCollectionEnabled
  }
}

/** 当前是否允许自动跑周期采集（唯一判断点，避免两处口径不一致） */
function autoCollectionOn(): boolean {
  try { return runtime().autoCollectionEnabled?.() ?? isAutoCollectionEnabled() } catch { return false }
}

let runtimeFactory: () => SalesMetricsSchedulerRuntime = defaultRuntime
let timer: NodeJS.Timeout | null = null
let lastPlanSyncAt = 0
let lastHealthFingerprint = ''
let lastLedger: SalesMetricsLedger | null = null

/** 正在跑的店铺（每店一把锁）。 */
const inFlight = new Set<string>()
/** 手动"立即采集"请求：不能改调度语义，所以放在内存队列里由 tick 统一执行。 */
const manualQueue = new Set<string>()
let started = false

/** 测试注入点：替换运行环境（假时钟/假台账/假采集）。 */
export function setSalesMetricsSchedulerRuntimeForTests(factory: (() => SalesMetricsSchedulerRuntime) | null): void {
  runtimeFactory = factory || defaultRuntime
}

function runtime(): SalesMetricsSchedulerRuntime { return runtimeFactory() }

/** 事件负载：只允许这九个字段（§10），绝不带 Cookie/Session/页面正文/网络响应。 */
export interface SalesMetricsEventPayload {
  storeId: string
  platform: string
  runId: string | null
  status: SalesMetricsCollectionStatus
  reasonCode: string | null
  collectedAt: number | null
  nextRunAt: number | null
  consecutiveFailures: number
  freshness: SalesMetricsFreshness
}

function emitPlanUpdated(payload: SalesMetricsEventPayload): void {
  try { runtime().emit(EVENT_CHANNELS.SALES_METRICS_PLAN_UPDATED, payload) } catch { /* 没有窗口/已销毁：忽略 */ }
}

function emitRunStarted(payload: SalesMetricsEventPayload): void {
  try { runtime().emit(EVENT_CHANNELS.SALES_METRICS_RUN_STARTED, payload) } catch { /* ignore */ }
}

function emitRunFinished(payload: SalesMetricsEventPayload): void {
  try { runtime().emit(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, payload) } catch { /* ignore */ }
}

function emitHealthChanged(): void {
  try {
    const view = healthSnapshot()
    const fingerprint = JSON.stringify(view.counters)
    if (fingerprint === lastHealthFingerprint) return
    lastHealthFingerprint = fingerprint
    runtime().emit(EVENT_CHANNELS.SALES_METRICS_HEALTH_CHANGED, { computedAt: view.computedAt, counters: view.counters, nextRunAt: view.nextRunAt, lastSuccessAt: view.lastSuccessAt })
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * 计划同步
 * ------------------------------------------------------------------ */

/**
 * 新建缺失的计划、停掉已消失店铺的计划。
 *
 * `reanchor` 只在启动时为真：那一拍要把"停机期间已过去的计划点"重开成 now+周期+抖动，
 * 避免启动瞬间把积压的多个周期连发（§7.4）。运行中必须保持用户看到的下一次采集时刻。
 */
function syncPlans(now: number, reanchor: boolean): { created: number; disabled: number; reanchored: number } {
  const ledger = runtime().ledger
  return ledger.syncPlans({
    stores: runtime().listStores(),
    now,
    intervalMs: SALES_METRICS_INTERVAL_MS,
    // 自动采集总开关（默认关）：关着的时候这里只负责"把计划停掉"，不再自动开计划
    autoEnabled: autoCollectionOn(),
    anchor: reanchor
      ? anchorNextRun
      : (previous, interval, current, jitter) => (previous != null && Number.isFinite(previous) ? previous : current + interval + jitter),
    jitterFor: jitterMsForStore,
    supported: platform => !!businessProfileFor(platform)
  })
}

/* ------------------------------------------------------------------ *
 * 单次运行
 * ------------------------------------------------------------------ */

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timerHandle: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => reject(new Error('COLLECTION_TIMEOUT')), timeoutMs)
    if (typeof timerHandle.unref === 'function') timerHandle.unref()
  })
  return Promise.race([promise, timeout]).finally(() => { if (timerHandle) clearTimeout(timerHandle) })
}

function timeoutResult(storeId: string, platform: string): SalesMetricsCollectionResult {
  const at = Date.now()
  return {
    storeId, platform, status: 'TIMEOUT', startedAt: at, finishedAt: at,
    periodStart: null, periodEnd: null, storeMetricsCount: 0, productMetricsCount: 0,
    inserted: 0, updated: 0, skipped: 0, failed: 0, sourceType: 'NONE',
    reasonCode: 'COLLECTION_TIMEOUT', safeMessage: '本次采集超过时间上限，已中断',
    adapterVersion: null, metricDefinitionVersion: 'sales-metrics-1',
    sourceUpdatedAt: null, dataStatus: 'COLLECTION_FAILED', evidence: null
  }
}

async function runPlan(plan: { storeId: string; platform: string; nextRunAt: number | null; intervalMs: number; consecutiveFailures: number }): Promise<void> {
  if (inFlight.has(plan.storeId)) return
  inFlight.add(plan.storeId)
  const ledger = runtime().ledger
  const now = runtime().now()
  const jitter = jitterMsForStore(plan.storeId)
  let runId: string | null = null
  try {
    const started = ledger.markRunStart({
      storeId: plan.storeId,
      platform: plan.platform,
      plannedAt: plan.nextRunAt ?? now,
      now,
      intervalMs: plan.intervalMs
    })
    runId = started.runId
    emitRunStarted({
      storeId: plan.storeId, platform: plan.platform, runId,
      status: 'RUNNING', reasonCode: null, collectedAt: null,
      nextRunAt: null, consecutiveFailures: plan.consecutiveFailures, freshness: 'UNAVAILABLE'
    })
  } catch (error) {
    logMain('warn', `[sales-metrics-scheduler] markRunStart failed store=${plan.storeId}: ${String(error).slice(0, 160)}`)
    inFlight.delete(plan.storeId)
    return
  }

  let result: SalesMetricsCollectionResult
  try {
    result = await withHardTimeout(
      runtime().collect({ storeId: plan.storeId, timeoutMs: RUN_ADAPTER_BUDGET_MS }, { runId }),
      RUN_HARD_TIMEOUT_MS
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = timeoutResult(plan.storeId, plan.platform)
    if (message !== 'COLLECTION_TIMEOUT') {
      result.status = 'ERROR'
      result.reasonCode = 'SCHEDULER_ERROR'
      result.safeMessage = '采集调度失败'
    }
  }

  try {
    const finishedAt = runtime().now()
    const transition = planTransition({
      status: result.status,
      previousFailures: plan.consecutiveFailures,
      now: finishedAt,
      intervalMs: plan.intervalMs,
      jitterMs: jitter
    })
    const refreshLastSuccess = result.status === 'SUCCEEDED' || result.status === 'PARTIAL'
    ledger.finishRun({
      runId,
      storeId: plan.storeId,
      status: result.status,
      reasonCode: result.reasonCode,
      safeMessage: result.safeMessage,
      adapterVersion: result.adapterVersion,
      sourceType: result.sourceType,
      dataStatus: result.dataStatus,
      inserted: result.inserted,
      updated: result.updated,
      now: finishedAt,
      intervalMs: plan.intervalMs,
      jitterMs: jitter,
      transition,
      metricsSnapshotJson: null,
      refreshLastSuccess
    })
    // 成功分支要把"这一拍写进去的聚合值"补进运行记录，供 24 小时趋势使用。
    // 带上主口径的区间：一次采集可能写多个口径，快照要取**主口径**那一行。
    if (refreshLastSuccess) {
      const period = Number.isFinite(result.periodStart) && Number.isFinite(result.periodEnd)
        ? { start: Number(result.periodStart), end: Number(result.periodEnd) }
        : undefined
      try { ledger.attachRunMetricsSnapshot(runId, plan.storeId, period) } catch { /* 趋势缺一次点不影响采集 */ }
    }
    const freshness = computeFreshness({
      lastSuccessAt: refreshLastSuccess ? finishedAt : (runtime().ledger.getPlan(plan.storeId)?.lastSuccessAt ?? null),
      lastStatus: result.status,
      now: finishedAt
    })
    const payload: SalesMetricsEventPayload = {
      storeId: plan.storeId,
      platform: plan.platform,
      runId,
      status: result.status,
      reasonCode: result.reasonCode,
      collectedAt: result.finishedAt,
      nextRunAt: transition.nextRunAt,
      consecutiveFailures: transition.countsAsFailure ? plan.consecutiveFailures + 1 : 0,
      freshness
    }
    emitRunFinished(payload)
    emitPlanUpdated(payload)
    emitHealthChanged()
    logMain('info', `[sales-metrics-scheduler] ${JSON.stringify({
      runId, storeId: plan.storeId, platform: plan.platform,
      status: result.status, reasonCode: result.reasonCode, dataStatus: result.dataStatus,
      inserted: result.inserted, updated: result.updated,
      nextRunAt: transition.nextRunAt, circuitOpen: transition.circuitOpen
    })}`)
  } catch (error) {
    logMain('warn', `[sales-metrics-scheduler] finishRun failed store=${plan.storeId}: ${String(error).slice(0, 160)}`)
  } finally {
    inFlight.delete(plan.storeId)
  }
}

/* ------------------------------------------------------------------ *
 * 节拍
 * ------------------------------------------------------------------ */

function duePlanFor(storeId: string, now: number): { storeId: string; platform: string; nextRunAt: number | null; intervalMs: number; consecutiveFailures: number } | null {
  const plan = runtime().ledger.getPlan(storeId)
  if (!plan) return null
  return { storeId: plan.storeId, platform: plan.platform, nextRunAt: plan.nextRunAt ?? now, intervalMs: plan.intervalMs, consecutiveFailures: plan.consecutiveFailures }
}

/** 导出供单测直接驱动节拍（不依赖真实定时器）。 */
export function tickSalesMetricsScheduler(): void {
  try {
    const now = runtime().now()
    if (now - lastPlanSyncAt >= PLAN_SYNC_INTERVAL_MS) {
      lastPlanSyncAt = now
      const synced = syncPlans(now, false)
      if (synced.created || synced.disabled) {
        logMain('info', `[sales-metrics-scheduler] 计划同步：新建 ${synced.created}，停用 ${synced.disabled}`)
        emitHealthChanged()
      }
    }
  } catch (error) {
    // 数据库瞬态异常（关库/锁）不能让定时器把异常抛到主进程
    logMain('warn', `[sales-metrics-scheduler] plan sync failed: ${String(error).slice(0, 160)}`)
  }

  try {
    const now = runtime().now()
    // 手动队列非空 → 放宽并发（用户在看）；纯周期采集按保守的 2 家跑。
    const cap = manualQueue.size > 0 ? Math.max(SALES_METRICS_MAX_PARALLEL, MANUAL_MAX_PARALLEL) : SALES_METRICS_MAX_PARALLEL
    let capacity = cap - inFlight.size
    // 手动请求优先于周期请求：用户刚点了"立即采集"，不该排在 10 分钟周期后面。
    for (const storeId of [...manualQueue]) {
      if (capacity <= 0) break
      if (inFlight.has(storeId)) continue
      manualQueue.delete(storeId)
      const plan = duePlanFor(storeId, now)
      if (!plan) continue
      capacity--
      void runPlan(plan)
    }
    if (capacity > 0) {
      // 周期采集只在自动采集开着时跑；关着时这里什么都不做——
      // 手动队列（用户点的「立即采集」）在上面已经处理，不受这个开关影响。
      const autoEnabled = autoCollectionOn()
      for (const plan of autoEnabled ? runtime().ledger.listDuePlans(now, capacity) : []) {
        void runPlan({
          storeId: plan.storeId,
          platform: plan.platform,
          nextRunAt: plan.nextRunAt,
          intervalMs: plan.intervalMs,
          consecutiveFailures: plan.consecutiveFailures
        })
      }
    }
  } catch (error) {
    logMain('warn', `[sales-metrics-scheduler] tick failed: ${String(error).slice(0, 160)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

export function startSalesMetricsScheduler(): void {
  if (started) return
  started = true
  try {
    const ledger = runtime().ledger
    lastLedger = ledger
    // 上一次进程被杀时留下的 RUNNING 必须先收敛：否则"还在采集"永远为真（§7.11）。
    const orphans = ledger.reconcileOrphanRuns(runtime().now())
    if (orphans) logMain('warn', `[sales-metrics-scheduler] 收敛 ${orphans} 条残留 RUNNING 为 INTERRUPTED`)
  } catch (error) {
    logMain('warn', `[sales-metrics-scheduler] 启动收敛失败：${String(error).slice(0, 160)}`)
  }
  try {
    const now = runtime().now()
    const synced = syncPlans(now, true)
    lastPlanSyncAt = now
    logMain('info', `[sales-metrics-scheduler] 计划就绪：新建 ${synced.created}，停用 ${synced.disabled}，重锚 ${synced.reanchored}`)
  } catch { /* 数据库初始化瞬态：下一拍同步 */ }
  timer = setInterval(() => { void tickSalesMetricsScheduler() }, TICK_MS)
  // 常驻定时器不阻止进程退出（退出路径见 index.ts 的 will-quit）
  if (typeof timer.unref === 'function') timer.unref()
  logMain('info', `[sales-metrics-scheduler] started interval=${SALES_METRICS_INTERVAL_MS}ms maxParallel=${SALES_METRICS_MAX_PARALLEL}`)
}

/**
 * 停机：清定时器、清内存队列，并把仍在跑的运行如实标记为中断。
 *
 * 标记中断而不是留给下次启动收敛，是因为退出过程中库还开着（will-quit 才关库），
 * 此时能写最后一次并且写成功；下次启动的收敛是"被强杀"时的兜底。
 */
export function stopSalesMetricsScheduler(options: { markInterrupted?: boolean } = {}): void {
  started = false
  if (timer) { clearInterval(timer); timer = null }
  manualQueue.clear()
  lastHealthFingerprint = ''
  if (options.markInterrupted !== false) {
    try {
      const orphans = lastLedger?.reconcileOrphanRuns(Date.now()) || 0
      if (orphans) logMain('warn', `[sales-metrics-scheduler] 退出：${orphans} 条运行标记为 INTERRUPTED`)
    } catch { /* 退出路径不抛错 */ }
  }
  inFlight.clear()
  lastLedger = null
}

/** 兼容旧名（测试与既有调用点）。 */
export function resetSalesMetricsSchedulerForTests(): void { stopSalesMetricsScheduler({ markInterrupted: false }); setSalesMetricsSchedulerRuntimeForTests(null) }

/* ------------------------------------------------------------------ *
 * 手动操作（供 IPC 层调用）
 * ------------------------------------------------------------------ */

export interface ManualRunRequest {
  queued: boolean
  reasonCode: string
  storeId: string
}

/**
 * 「立即采集」：把请求放进内存队列，由下一拍节拍按并发上限执行。
 *
 * 不直接调用采集服务，是为了让手动运行和周期运行走**同一条**路径：
 * 同样的并发上限、同样的运行记录、同样的状态机。走捷径就会出现
 * "手动跑成功但台账里没有这一条"。
 */
export function requestImmediateRun(storeId: string): ManualRunRequest {
  const runtimeValue = runtime()
  const store = runtimeValue.listStores().find(item => item.id === storeId)
  if (!store) return { queued: false, reasonCode: 'STORE_NOT_FOUND', storeId }
  let plan = runtimeValue.ledger.getPlan(storeId)
  if (!plan) {
    // 还没建计划（刚建店/计划同步还没扫到）→ **按需补建**，别让用户看到"这家店点不动"。
    // 但平台没有实测档案时不建：那种计划每一轮都只会失败，比拒绝更糟。
    if (!businessProfileFor(store.platform)) return { queued: false, reasonCode: 'PLATFORM_PROFILE_NOT_MEASURED', storeId }
    const created = runtimeValue.ledger.ensurePlan({
      storeId, platform: store.platform, now: runtimeValue.now(),
      intervalMs: SALES_METRICS_INTERVAL_MS, jitterMs: jitterMsForStore(storeId),
      autoEnabled: autoCollectionOn()
    })
    if (created) logMain('info', `[sales-metrics-scheduler] 手动采集按需建计划 store=${storeId} platform=${store.platform}`)
    plan = runtimeValue.ledger.getPlan(storeId)
    if (!plan) return { queued: false, reasonCode: 'PLAN_NOT_FOUND', storeId }
  }
  if (inFlight.has(storeId) || manualQueue.has(storeId)) return { queued: false, reasonCode: 'ALREADY_RUNNING', storeId }
  manualQueue.add(storeId)
  try { runtimeValue.ledger.scheduleImmediate(storeId, runtimeValue.now()) } catch { /* 节拍仍会执行 */ }
  // 不改变 enabled：暂停中的店铺也能单跑一次（用户手动点的不该被计划开关挡住）。
  return { queued: true, reasonCode: 'QUEUED', storeId }
}

export function updatePlanSettings(storeId: string, patch: { enabled?: boolean; intervalMs?: number }): boolean {
  const runtimeValue = runtime()
  const now = runtimeValue.now()
  const changed = runtimeValue.ledger.updatePlanSettings(storeId, patch, now, jitterMsForStore(storeId))
  if (!changed) return false
  const plan = runtimeValue.ledger.getPlan(storeId)
  emitPlanUpdated({
    storeId,
    platform: plan?.platform || '',
    runId: null,
    status: plan?.lastStatus || 'READY',
    reasonCode: plan?.lastReasonCode || null,
    collectedAt: null,
    nextRunAt: plan?.nextRunAt ?? null,
    consecutiveFailures: plan?.consecutiveFailures || 0,
    freshness: 'UNAVAILABLE'
  })
  emitHealthChanged()
  return true
}

export function pausePlan(storeId: string): boolean {
  const runtimeValue = runtime()
  const ok = runtimeValue.ledger.pausePlan(storeId, runtimeValue.now())
  if (!ok) return false
  const plan = runtimeValue.ledger.getPlan(storeId)
  emitPlanUpdated({
    storeId, platform: plan?.platform || '', runId: null, status: 'DISABLED',
    reasonCode: 'PLAN_PAUSED', collectedAt: null, nextRunAt: null,
    consecutiveFailures: plan?.consecutiveFailures || 0,
    freshness: computeFreshness({ lastSuccessAt: plan?.lastSuccessAt ?? null, lastStatus: 'DISABLED', now: runtimeValue.now() })
  })
  emitHealthChanged()
  return true
}

export function resumePlan(storeId: string): boolean {
  const runtimeValue = runtime()
  const ok = runtimeValue.ledger.resumePlan(storeId, runtimeValue.now(), jitterMsForStore(storeId))
  if (!ok) return false
  const plan = runtimeValue.ledger.getPlan(storeId)
  emitPlanUpdated({
    storeId, platform: plan?.platform || '', runId: null, status: 'READY',
    reasonCode: 'PLAN_RESUMED', collectedAt: null, nextRunAt: plan?.nextRunAt ?? null,
    consecutiveFailures: 0, freshness: 'UNAVAILABLE'
  })
  emitHealthChanged()
  return true
}

/* ------------------------------------------------------------------ *
 * 查询（供 IPC 层调用）
 * ------------------------------------------------------------------ */

/**
 * 立即同步一次计划。
 *
 * 节拍里的同步有 30 秒节流（没必要每秒扫计划表），但**用户刚建的店铺**如果等 30 秒
 * 才在数据中心露面，看起来就像"新店铺没有被纳入调度"。列表查询先补一次同步，
 * 让"读"也顺手修一下：读到的就是当前真相。
 */
export function syncPlansNow(): void {
  try {
    const synced = syncPlans(runtime().now(), false)
    if (synced.created || synced.disabled) logMain('info', `[sales-metrics-scheduler] 按需同步计划：新建 ${synced.created}，停用 ${synced.disabled}`)
  } catch { /* 读路径不因同步失败而失败 */ }
}

export function listPlanViews(now = Date.now()): SalesMetricsPlanView[] {
  return runtime().ledger.listPlanViews(now)
}

export function getPlanView(storeId: string, now = Date.now()): SalesMetricsPlanView | null {
  return listPlanViews(now).find(view => view.storeId === storeId) || null
}

export function healthSnapshot(now = Date.now()): ReturnType<SalesMetricsLedger['health']> {
  const views = listPlanViews(now)
  return runtime().ledger.health(now, views)
}

export function listRuns(query: Parameters<SalesMetricsLedger['listRuns']>[0]): ReturnType<SalesMetricsLedger['listRuns']> {
  return runtime().ledger.listRuns(query)
}

export function planTrend(storeId: string, now = Date.now()): ReturnType<SalesMetricsLedger['trend']> {
  return runtime().ledger.trend(storeId, now - 24 * 60 * 60 * 1000)
}
