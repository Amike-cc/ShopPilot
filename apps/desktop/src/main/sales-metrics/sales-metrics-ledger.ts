/**
 * 经营采集台账：计划、运行记录、脱敏证据、健康汇总（开发文档 §6/§7/§10）。
 *
 * 与 `sales-metrics-repository.ts` 分开：那里只管**统一指标**的读写，
 * 这里只管"何时采、采成什么样、为什么失败"。两张表的事务必须互相独立，
 * 否则一次证据写入失败会把已经采到的指标一起回滚。
 *
 * 三条硬约束：
 *   1. 所有多语句写入走事务（`transaction()` 兼容 better-sqlite3 与 node:sqlite）。
 *   2. 证据表只写入脱敏摘要——没有 Cookie/Session/买家信息/完整响应，摘要本身不可逆。
 *   3. 失败不删除、不覆盖最近一次成功数据：这里只更新状态列，从不写指标列。
 */
import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  SalesMetricsCollectionStatus,
  SalesMetricsDataStatus,
  SalesMetricsFreshness,
  SalesMetricsHealth,
  SalesMetricsHealthCounters,
  SalesMetricsPlanView,
  SalesMetricsRunListResult,
  SalesMetricsRunQuery,
  SalesMetricsRunView,
  SalesMetricsSourceType,
  SalesMetricsTrendPoint,
  SalesMetrics
} from '@shared/contracts/sales-metrics'
import {
  SALES_METRICS_DEFAULT_INTERVAL_MS,
  SALES_METRICS_METRIC_DEFINITION_VERSION,
  computeFreshness,
  deriveDataStatus,
  normalizeCollectionStatus
} from '@shared/sales-metrics-rules'
// 单一列映射来源：台账与指标仓库必须读同一份 mapStoreMetricRow，
// 否则一张表两处解释，新增列时必然有一边漏读。
import { mapStoreMetricRow } from './sales-metrics-repository'

export interface SalesCollectionPlanRow {
  storeId: string
  platform: string
  enabled: boolean
  intervalMs: number
  timezone: string
  nextRunAt: number | null
  lastStartedAt: number | null
  lastSuccessAt: number | null
  lastStatus: SalesMetricsCollectionStatus | null
  lastReasonCode: string | null
  lastSafeMessage: string | null
  consecutiveFailures: number
  backoffUntil: number | null
  updatedAt: number
}

export interface SalesCollectionRunRow {
  runId: string
  storeId: string
  platform: string
  plannedAt: number
  startedAt: number | null
  finishedAt: number | null
  status: SalesMetricsCollectionStatus
  reasonCode: string | null
  safeMessage: string | null
  retryCount: number
  durationMs: number | null
  adapterVersion: string | null
  sourceType: SalesMetricsSourceType | null
  inserted: number
  updated: number
}

export interface SalesCollectionEvidenceInput {
  runId: string
  storeId: string
  platform: string
  fieldName: string
  valueType: 'NUMBER' | 'MINOR_AMOUNT' | 'TIMESTAMP' | 'TEXT' | 'ORDER_COUNT' | 'QUANTITY'
  sourceType: SalesMetricsSourceType
  sourceUrl: string
  capturedAt: number
  parserVersion: string | null
  confidence: number | null
}

/** 证据摘要：只对"这次观测的形状"取哈希，不含任何数值、页面正文或凭据，因此不可逆。 */
export function evidenceDigest(input: Pick<SalesCollectionEvidenceInput, 'storeId' | 'platform' | 'fieldName' | 'valueType' | 'sourceType' | 'parserVersion'>): string {
  return createHash('sha256')
    .update([input.storeId, input.platform, input.fieldName, input.valueType, input.sourceType, input.parserVersion || ''].join('|'))
    .digest('hex')
    .slice(0, 32)
}

/** 页面地址只留哈希：既能判别"同一页面"，又不把带参数的后台 URL 原样落库。 */
export function sourceUrlHash(url: string): string | null {
  const trimmed = String(url || '').trim()
  if (!trimmed) return null
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 32)
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

function mapPlan(row: Record<string, unknown>): SalesCollectionPlanRow {
  return {
    storeId: String(row.store_id),
    platform: String(row.platform),
    enabled: Number(row.enabled) === 1,
    intervalMs: Number(row.interval_ms) || SALES_METRICS_DEFAULT_INTERVAL_MS,
    timezone: String(row.timezone || 'Asia/Shanghai'),
    nextRunAt: nullableNumber(row.next_run_at),
    lastStartedAt: nullableNumber(row.last_started_at),
    lastSuccessAt: nullableNumber(row.last_success_at),
    lastStatus: normalizeCollectionStatus(row.last_status),
    lastReasonCode: nullableString(row.last_reason_code),
    lastSafeMessage: nullableString(row.last_safe_message),
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    backoffUntil: nullableNumber(row.backoff_until),
    updatedAt: Number(row.updated_at) || 0
  }
}

function mapRun(row: Record<string, unknown>): SalesCollectionRunRow {
  return {
    runId: String(row.run_id),
    storeId: String(row.store_id),
    platform: String(row.platform),
    plannedAt: Number(row.planned_at) || 0,
    startedAt: nullableNumber(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    status: normalizeCollectionStatus(row.status) || 'ERROR',
    reasonCode: nullableString(row.reason_code),
    safeMessage: nullableString(row.safe_message),
    retryCount: Number(row.retry_count) || 0,
    durationMs: nullableNumber(row.duration_ms),
    adapterVersion: nullableString(row.adapter_version),
    sourceType: (nullableString(row.source_type) as SalesMetricsSourceType | null) || null,
    inserted: Number(row.inserted) || 0,
    updated: Number(row.updated) || 0
  }
}

function toRunView(run: SalesCollectionRunRow): SalesMetricsRunView {
  return {
    runId: run.runId,
    storeId: run.storeId,
    platform: run.platform,
    plannedAt: run.plannedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    reasonCode: run.reasonCode,
    safeMessage: run.safeMessage,
    retryCount: run.retryCount,
    durationMs: run.durationMs,
    adapterVersion: run.adapterVersion,
    sourceType: run.sourceType,
    inserted: run.inserted,
    updated: run.updated
  }
}

/** 计划里只保留可持久化的九个指标快照（不含商品明细、订单正文或买家信息）。 */
export function metricsSnapshotJson(metrics: SalesMetrics | null | undefined): string | null {
  if (!metrics) return null
  return JSON.stringify({
    orderCount: metrics.orderCount,
    paidOrderCount: metrics.paidOrderCount,
    salesQuantity: metrics.salesQuantity,
    grossSalesAmountMinor: metrics.grossSalesAmountMinor,
    paidSalesAmountMinor: metrics.paidSalesAmountMinor,
    refundAmountMinor: metrics.refundAmountMinor,
    refundOrderCount: metrics.refundOrderCount,
    refundQuantity: metrics.refundQuantity,
    netSalesAmountMinor: metrics.netSalesAmountMinor,
    adSpendMinor: metrics.adSpendMinor,
    periodStart: metrics.periodStart,
    periodEnd: metrics.periodEnd
  })
}

export class SalesMetricsLedger {
  constructor(private readonly db: Database.Database) {}

  private transaction<T>(fn: () => T): T {
    const candidate = this.db as unknown as { transaction?: <R>(work: () => R) => () => R }
    if (typeof candidate.transaction === 'function') return (candidate.transaction as <R>(work: () => R) => () => R)(fn)()
    this.db.exec('BEGIN')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* noop */ } ; throw error }
  }

  /* ------------------------------------------------------------------ *
   * 计划
   * ------------------------------------------------------------------ */

  /**
   * 为新店铺建计划、为消失的店铺停计划。
   *
   * `anchor` 只在**启动/店铺新增**时使用：停机期间错过的周期不补发（§7.4），
   * 把已经过期的 next_run_at 重开成 now + interval + jitter，避免启动瞬间连发。
   * 已存在且未过期的计划点保持不动——那是用户真正期待的下一次采集时刻。
   */
  syncPlans(input: {
    stores: ReadonlyArray<{ id: string; platform: string }>
    now: number
    intervalMs: number
    anchor: (previousNextRunAt: number | null, intervalMs: number, now: number, jitterMs: number) => number
    jitterFor: (storeId: string) => number
  }): { created: number; disabled: number; reanchored: number } {
    const active = new Map(input.stores.map(store => [store.id, store]))
    let created = 0
    let disabled = 0
    let reanchored = 0
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT store_id, next_run_at, enabled FROM sales_collection_plans').all() as Array<{ store_id: string; next_run_at: number | null; enabled: number }>
      const known = new Set(rows.map(row => row.store_id))
      for (const row of rows) {
        const store = active.get(row.store_id)
        // 店铺被删除（回收站）时停掉计划：FK CASCADE 只在硬删除时触发，
        // 软删除的店铺若继续调度，会在用户已经"删掉"的店上反复失败。
        if (!store) {
          if (Number(row.enabled) === 1) {
            this.db.prepare('UPDATE sales_collection_plans SET enabled = 0, next_run_at = NULL, last_status = ?, last_reason_code = ?, last_safe_message = ?, backoff_until = NULL, updated_at = ? WHERE store_id = ?')
              .run('DISABLED', 'STORE_NOT_ACTIVE', '店铺已删除或移入回收站，采集计划已停止', input.now, row.store_id)
            disabled++
          }
          continue
        }
        // 平台改名/换平台：以 stores 为准
        const reanchoredAt = input.anchor(row.next_run_at, input.intervalMs, input.now, input.jitterFor(row.store_id))
        if (Number(row.enabled) === 1 && reanchoredAt !== Number(row.next_run_at)) {
          this.db.prepare('UPDATE sales_collection_plans SET next_run_at = ?, updated_at = ? WHERE store_id = ?').run(reanchoredAt, input.now, row.store_id)
          reanchored++
        }
      }
      const insert = this.db.prepare(`
        INSERT INTO sales_collection_plans (store_id, platform, enabled, interval_ms, timezone, next_run_at, last_status, updated_at)
        VALUES (?, ?, 1, ?, 'Asia/Shanghai', ?, 'READY', ?)
        ON CONFLICT(store_id) DO UPDATE SET platform = excluded.platform
      `)
      for (const store of input.stores) {
        if (known.has(store.id)) continue
        insert.run(store.id, store.platform, input.intervalMs, input.now + input.intervalMs + input.jitterFor(store.id), input.now)
        created++
      }
      return { created, disabled, reanchored }
    })
  }

  listPlans(): SalesCollectionPlanRow[] {
    const rows = this.db.prepare('SELECT * FROM sales_collection_plans').all() as Array<Record<string, unknown>>
    return rows.map(mapPlan)
  }

  getPlan(storeId: string): SalesCollectionPlanRow | null {
    const row = this.db.prepare('SELECT * FROM sales_collection_plans WHERE store_id = ?').get(storeId) as Record<string, unknown> | undefined
    return row ? mapPlan(row) : null
  }

  /** 到期计划：只取启用、未到退避截止、且**并发额度内**的店铺。 */
  listDuePlans(now: number, limit: number): SalesCollectionPlanRow[] {
    if (limit <= 0) return []
    const rows = this.db.prepare(`
      SELECT * FROM sales_collection_plans
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        AND (backoff_until IS NULL OR backoff_until <= ?)
      ORDER BY next_run_at ASC LIMIT ?
    `).all(now, now, limit) as Array<Record<string, unknown>>
    return rows.map(mapPlan)
  }

  /**
   * 改计划设置。
   *
   * 周期变短时**要把下一次采集提前**，否则用户把 10 分钟改成 1 分钟之后，
   * 第一次采集仍然按旧计划点排在 10 分钟后，"改周期"看起来毫无效果
   * （连续运行验收脚本正是这样卡住的：等了 13 分钟一条运行记录都没有）。
   * 只提前、不延后：拉长周期不应该把已经快到的采集推走。
   */
  updatePlanSettings(storeId: string, patch: { enabled?: boolean; intervalMs?: number }, now: number, jitterMs = 0): boolean {
    const plan = this.getPlan(storeId)
    if (!plan) return false
    const intervalMs = patch.intervalMs == null ? plan.intervalMs : Math.max(60_000, Math.floor(patch.intervalMs))
    const enabled = patch.enabled == null ? plan.enabled : patch.enabled
    const forward = now + intervalMs + Math.max(0, Math.floor(jitterMs))
    let nextRunAt: number | null = plan.nextRunAt
    if (!enabled) nextRunAt = null
    else if (nextRunAt == null) nextRunAt = forward
    else if (intervalMs !== plan.intervalMs && patch.intervalMs != null) nextRunAt = Math.min(nextRunAt, forward)
    this.transaction(() => {
      this.db.prepare('UPDATE sales_collection_plans SET enabled = ?, interval_ms = ?, next_run_at = ?, updated_at = ? WHERE store_id = ?')
        .run(enabled ? 1 : 0, intervalMs, nextRunAt, now, storeId)
    })
    return true
  }

  /**
   * 暂停：停发计划点并置 DISABLED。
   * 暂停**不清空**上次成功值与失败计数——恢复后要能看到"上次成功是什么时候"。
   */
  pausePlan(storeId: string, now: number): boolean {
    const plan = this.getPlan(storeId)
    if (!plan) return false
    this.transaction(() => {
      this.db.prepare(`UPDATE sales_collection_plans SET enabled = 0, next_run_at = NULL, backoff_until = NULL,
        last_status = 'DISABLED', last_reason_code = 'PLAN_PAUSED', last_safe_message = '采集计划已由用户暂停', updated_at = ? WHERE store_id = ?`)
        .run(now, storeId)
    })
    return true
  }

  /**
   * 恢复：重新排下一次采集（now + 周期 + 抖动），并清零失败计数与熔断。
   * 「恢复成功后自动回到十分钟周期」——所以周期取计划里保存的 interval_ms，而不是另设默认值。
   */
  resumePlan(storeId: string, now: number, jitterMs: number): boolean {
    const plan = this.getPlan(storeId)
    if (!plan) return false
    this.transaction(() => {
      this.db.prepare(`UPDATE sales_collection_plans SET enabled = 1, next_run_at = ?, backoff_until = NULL,
        consecutive_failures = 0, last_status = 'READY', last_reason_code = 'PLAN_RESUMED', last_safe_message = '采集计划已恢复', updated_at = ? WHERE store_id = ?`)
        .run(now + plan.intervalMs + jitterMs, now, storeId)
    })
    return true
  }

  /** 手动立即采集：把下一个计划点拉到当下，但**不改变 enabled**——暂停中的店铺也能单跑一次。 */
  scheduleImmediate(storeId: string, now: number): boolean {
    const plan = this.getPlan(storeId)
    if (!plan) return false
    this.transaction(() => {
      this.db.prepare('UPDATE sales_collection_plans SET next_run_at = ?, backoff_until = NULL, updated_at = ? WHERE store_id = ?')
        .run(now, now, storeId)
    })
    return true
  }

  /* ------------------------------------------------------------------ *
   * 运行记录
   * ------------------------------------------------------------------ */

  markRunStart(input: {
    storeId: string
    platform: string
    plannedAt: number
    now: number
    intervalMs: number
    runId?: string
  }): { runId: string; startedAt: number } {
    const runId = input.runId || randomUUID()
    const startedAt = input.now
    this.transaction(() => {
      this.db.prepare(`INSERT INTO sales_collection_runs (run_id, store_id, platform, planned_at, started_at, status, data_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'RUNNING', 'UNKNOWN', ?)`)
        .run(runId, input.storeId, input.platform, input.plannedAt, startedAt, startedAt)
      // 先把计划点推到下一个周期（+ 抖动），这样即使进程在运行中被杀，
      // 下次启动也不会在同一秒重复触发同一个计划点。
      this.db.prepare(`UPDATE sales_collection_plans SET last_started_at = ?, last_status = 'RUNNING', updated_at = ? WHERE store_id = ?`)
        .run(startedAt, startedAt, input.storeId)
    })
    return { runId, startedAt }
  }

  finishRun(input: {
    runId: string
    storeId: string
    status: SalesMetricsCollectionStatus
    reasonCode: string | null
    safeMessage: string | null
    adapterVersion: string | null
    sourceType: SalesMetricsSourceType | null
    dataStatus: SalesMetricsDataStatus
    inserted: number
    updated: number
    now: number
    intervalMs: number
    jitterMs: number
    transition: {
      countsAsFailure: boolean
      requiresUserAction: boolean
      circuitOpen: boolean
      nextRunAt: number | null
      backoffUntil: number | null
    }
    metricsSnapshotJson: string | null
    /** 成功/部分成功才刷新 last_success_at；失败绝不刷新。 */
    refreshLastSuccess: boolean
  }): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT started_at FROM sales_collection_runs WHERE run_id = ?').get(input.runId) as { started_at?: number } | undefined
      const duration = row?.started_at ? input.now - Number(row.started_at) : null
      this.db.prepare(`UPDATE sales_collection_runs SET finished_at = ?, status = ?, reason_code = ?, safe_message = ?,
        duration_ms = ?, adapter_version = ?, source_type = ?, data_status = ?, inserted = ?, updated = ?, metrics_json = COALESCE(?, metrics_json)
        WHERE run_id = ?`)
        .run(input.now, input.status, input.reasonCode, input.safeMessage, duration, input.adapterVersion,
          input.sourceType, input.dataStatus, input.inserted, input.updated, input.metricsSnapshotJson, input.runId)

      const plan = this.getPlan(input.storeId)
      const failures = input.transition.countsAsFailure ? Number(plan?.consecutiveFailures || 0) + 1 : 0
      this.db.prepare(`UPDATE sales_collection_plans SET
          last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
          last_status = ?, last_reason_code = ?, last_safe_message = ?,
          consecutive_failures = ?, backoff_until = ?, next_run_at = ?,
          interval_ms = ?, updated_at = ? WHERE store_id = ?`)
        .run(input.refreshLastSuccess ? 1 : 0, input.refreshLastSuccess ? input.now : null,
          input.status, input.reasonCode, input.safeMessage, failures, input.transition.backoffUntil,
          input.transition.nextRunAt, input.intervalMs, input.now, input.storeId)
    })
  }

  /**
   * 启动自愈：上一次进程被杀时留下的 RUNNING 必须收敛成 INTERRUPTED（§7.11）。
   * 留在 RUNNING 的运行会让"是否还在采集"永远为真，前端会一直转圈。
   */
  reconcileOrphanRuns(now: number): number {
    return this.transaction(() => {
      const orphans = this.db.prepare("SELECT run_id, store_id FROM sales_collection_runs WHERE status = 'RUNNING'").all() as Array<{ run_id: string; store_id: string }>
      for (const orphan of orphans) {
        this.db.prepare(`UPDATE sales_collection_runs SET status = 'INTERRUPTED', finished_at = ?, reason_code = 'APP_RESTARTED',
          safe_message = '应用在上一次采集结束前退出，本次运行已标记为中断' WHERE run_id = ?`)
          .run(now, orphan.run_id)
      }
      return orphans.length
    })
  }

  listRuns(query: SalesMetricsRunQuery): SalesMetricsRunListResult {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize || 50)))
    const where: string[] = []
    const params: Array<string | number> = []
    if (query.storeId) { where.push('store_id = ?'); params.push(query.storeId) }
    if (query.platform) { where.push('platform = ?'); params.push(query.platform) }
    if (query.status) { where.push('status = ?'); params.push(query.status) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM sales_collection_runs ${clause}`).get(...params) as { count?: number })?.count || 0)
    const rows = this.db.prepare(`SELECT * FROM sales_collection_runs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>
    return { page, pageSize, total, items: rows.map(row => toRunView(mapRun(row))) }
  }

  latestRun(storeId: string): SalesMetricsRunView | null {
    const row = this.db.prepare('SELECT * FROM sales_collection_runs WHERE store_id = ? ORDER BY created_at DESC LIMIT 1').get(storeId) as Record<string, unknown> | undefined
    return row ? toRunView(mapRun(row)) : null
  }

  /** 最近 24 小时趋势：只取成功那一刻写的聚合快照，失败运行不留点（不制造假 0）。 */
  trend(storeId: string, since: number, limit = 144): SalesMetricsTrendPoint[] {
    const rows = this.db.prepare(`SELECT finished_at, created_at, status, metrics_json FROM sales_collection_runs
      WHERE store_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT ?`)
      .all(storeId, since, limit) as Array<{ finished_at: number | null; created_at: number; status: string; metrics_json: string | null }>
    return rows.map(row => {
      let snapshot: Partial<SalesMetrics> | null = null
      if (row.metrics_json) { try { snapshot = JSON.parse(row.metrics_json) as Partial<SalesMetrics> } catch { snapshot = null } }
      return {
        collectedAt: Number(row.finished_at || row.created_at) || 0,
        status: normalizeCollectionStatus(row.status) || 'ERROR',
        paidSalesAmountMinor: nullableNumber(snapshot?.paidSalesAmountMinor),
        paidOrderCount: nullableNumber(snapshot?.paidOrderCount),
        refundAmountMinor: nullableNumber(snapshot?.refundAmountMinor)
      }
    })
  }

  /**
   * 把本次成功采集写进 sales_metrics 的聚合值补记到运行记录。
   *
   * 为什么需要：24 小时趋势要的是"每次采集那一刻的值"，而 sales_metrics 每个周期只有一行
   * （同一周期反复采集是原地更新）。没有这一步，趋势图只能画出最后一次的值。
   * 只存九个聚合指标，不含商品明细或订单正文。
   */
  attachRunMetricsSnapshot(runId: string, storeId: string): number {
    const row = this.db.prepare('SELECT * FROM sales_metrics WHERE store_id = ? ORDER BY collected_at DESC, period_end DESC LIMIT 1').get(storeId) as Record<string, unknown> | undefined
    if (!row) return 0
    return this.db.prepare('UPDATE sales_collection_runs SET metrics_json = ? WHERE run_id = ?').run(metricsSnapshotJson(mapStoreMetricRow(row)), runId).changes
  }

  /* ------------------------------------------------------------------ *
   * 脱敏证据
   * ------------------------------------------------------------------ */

  insertEvidence(input: SalesCollectionEvidenceInput): void {
    this.db.prepare(`INSERT INTO sales_metrics_raw (id, run_id, store_id, platform, field_name, value_type,
        source_type, source_url_hash, captured_at, evidence_path, parser_version, confidence, evidence_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(randomUUID(), input.runId, input.storeId, input.platform, input.fieldName, input.valueType,
        input.sourceType, sourceUrlHash(input.sourceUrl), input.capturedAt, input.parserVersion,
        input.confidence, evidenceDigest(input))
  }

  insertEvidenceBatch(rows: readonly SalesCollectionEvidenceInput[]): number {
    if (!rows.length) return 0
    return this.transaction(() => { for (const row of rows) this.insertEvidence(row); return rows.length })
  }

  evidenceCountForRun(runId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM sales_metrics_raw WHERE run_id = ?').get(runId) as { count?: number })?.count || 0)
  }

  /* ------------------------------------------------------------------ *
   * 视图与健康
   * ------------------------------------------------------------------ */

  /**
   * 计划视图：把计划、店铺名、最近一次统一指标、新鲜度和数据状态合成前端要的一张表。
   * 每个字段都来自库里的真实记录；没有来源的字段保持 null，绝不用 0 顶替。
   */
  listPlanViews(now: number): SalesMetricsPlanView[] {
    const plans = this.db.prepare(`
      SELECT p.*, s.name AS store_name FROM sales_collection_plans p
      LEFT JOIN stores s ON s.id = p.store_id AND s.deleted_at IS NULL
      ORDER BY p.platform ASC, s.sort_order ASC
    `).all() as Array<Record<string, unknown>>
    return plans.map(row => {
      const plan = mapPlan(row)
      const metricsRow = this.db.prepare(`SELECT * FROM sales_metrics WHERE store_id = ? ORDER BY collected_at DESC, period_end DESC LIMIT 1`).get(plan.storeId) as Record<string, unknown> | undefined
      const metrics = metricsRow ? mapStoreMetricRow(metricsRow) : null
      const lastRun = this.latestRun(plan.storeId)
      const freshness = computeFreshness({ lastSuccessAt: plan.lastSuccessAt, lastStatus: plan.lastStatus, now })
      const dataStatus = deriveDataStatus({
        lastStatus: plan.lastStatus,
        freshness,
        hasMetrics: !!metrics,
        intervalMs: plan.intervalMs,
        now,
        lastSuccessAt: plan.lastSuccessAt
      })
      return {
        storeId: plan.storeId,
        storeName: String(row.store_name || '') || plan.storeId,
        platform: plan.platform,
        enabled: plan.enabled,
        intervalMs: plan.intervalMs,
        timezone: plan.timezone,
        nextRunAt: plan.nextRunAt,
        lastStartedAt: plan.lastStartedAt,
        lastSuccessAt: plan.lastSuccessAt,
        lastStatus: plan.lastStatus,
        lastReasonCode: plan.lastReasonCode,
        lastSafeMessage: plan.lastSafeMessage,
        consecutiveFailures: plan.consecutiveFailures,
        backoffUntil: plan.backoffUntil,
        circuitOpen: plan.lastStatus === 'CIRCUIT_OPEN',
        requiresUserAction: plan.lastStatus === 'LOGIN_REQUIRED' || plan.lastStatus === 'VERIFY_REQUIRED' ||
          plan.lastStatus === 'PERMISSION_DENIED' || plan.lastStatus === 'PAGE_CHANGED',
        freshness: freshness as SalesMetricsFreshness,
        dataStatus: dataStatus as SalesMetricsDataStatus,
        // 指标行没有版本时回落到最近一次运行的版本：否则一次失败运行在界面上会显示成
        // "未执行到 Adapter"，而它其实已经跑到 Adapter 并在导航阶段失败了（真机实测踩到）。
        adapterVersion: metrics?.adapterVersion || lastRun?.adapterVersion || null,
        metricDefinitionVersion: metrics?.metricDefinitionVersion || SALES_METRICS_METRIC_DEFINITION_VERSION,
        metrics,
        sourceType: metrics?.sourceType || 'NONE',
        sourceUpdatedAt: metrics?.sourceUpdatedAt ?? null,
        collectedAt: metrics?.collectedAt ?? null,
        lastRun,
        trend: this.trend(plan.storeId, now - 24 * 60 * 60 * 1000)
      } satisfies SalesMetricsPlanView
    })
  }

  health(now: number, views: readonly SalesMetricsPlanView[]): SalesMetricsHealth {
    const since = now - 24 * 60 * 60 * 1000
    const runs = this.db.prepare(`SELECT status, COUNT(*) AS count FROM sales_collection_runs WHERE created_at >= ? GROUP BY status`).all(since) as Array<{ status: string; count: number }>
    let failures = 0
    let successes = 0
    for (const row of runs) {
      const status = normalizeCollectionStatus(row.status)
      const count = Number(row.count) || 0
      if (status === 'SUCCEEDED' || status === 'PARTIAL' || status === 'DATA_SOURCE_NOT_VERIFIED') successes += count
      else if (status !== 'RUNNING' && status !== 'ALREADY_RUNNING') failures += count
    }
    const counters: SalesMetricsHealthCounters = {
      total: views.length,
      enabled: views.filter(view => view.enabled).length,
      paused: views.filter(view => !view.enabled).length,
      running: views.filter(view => view.lastStatus === 'RUNNING').length,
      fresh: views.filter(view => view.freshness === 'FRESH').length,
      aging: views.filter(view => view.freshness === 'AGING').length,
      stale: views.filter(view => view.freshness === 'STALE').length,
      unavailable: views.filter(view => view.freshness === 'UNAVAILABLE').length,
      sourceUnverified: views.filter(view => view.freshness === 'SOURCE_UNVERIFIED').length,
      requiresUserAction: views.filter(view => view.requiresUserAction).length,
      circuitOpen: views.filter(view => view.circuitOpen).length,
      failuresLast24h: failures,
      successesLast24h: successes
    }
    const attention = views
      .filter(view => view.requiresUserAction || view.circuitOpen || view.lastStatus === 'DATA_SOURCE_NOT_VERIFIED' || view.freshness === 'STALE' || view.freshness === 'UNAVAILABLE')
      .map(view => ({
        storeId: view.storeId,
        storeName: view.storeName,
        platform: view.platform,
        status: view.lastStatus || 'NOT_CONFIGURED',
        reasonCode: view.lastReasonCode,
        safeMessage: view.lastSafeMessage,
        since: view.lastStartedAt
      }))
    const nextRunAt = views.reduce<number | null>((min, view) => {
      if (!view.enabled || view.nextRunAt == null) return min
      return min == null ? view.nextRunAt : Math.min(min, view.nextRunAt)
    }, null)
    const lastSuccessAt = views.reduce<number | null>((max, view) => {
      if (view.lastSuccessAt == null) return max
      return max == null ? view.lastSuccessAt : Math.max(max, view.lastSuccessAt)
    }, null)
    return { computedAt: now, counters, attention, nextRunAt, lastSuccessAt }
  }
}
