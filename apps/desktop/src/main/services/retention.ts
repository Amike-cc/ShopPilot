/**
 * 数据保留策略（§28 的"清理"那一半）。
 *
 * 2026-09-28 审查实测背景：这个项目里会随运行**只增不减**的对象有九类
 * （截图工件 / store_snapshots / task_runs / task_step_results / audit_logs /
 * agent_usage / agent_job_events / agent_job_results / Chromium 分区目录），
 * 而当时只有三张**最不增长**的表配了清理（proxy_checks 100 条、backups 7 份、logs 14 天）。
 * 实测 20 天 5 家店：截图 113 个文件 6.1 MB、Chromium 分区 1.5 GB（含 5 个孤儿目录）、
 * backups 目录根本不存在。按 20 店规模外推截图 ≈40 GB/年 —— 磁盘写满后 SQLite 写入
 * 会直接失败，这是**可用性**问题，不是性能问题。
 *
 * 设计口径（几条硬约束）：
 *   · **默认保守**：时间窗给 365 天、快照每店每指标留 400 条、截图按任务留最近 60 次运行。
 *     清理的目的是"不让它无限长"，不是"尽快删数据"。
 *   · **只删自己产出的东西**：截图工件是引擎写的，快照是采集写的；都不碰用户手工录入的行
 *     （`store_snapshots.source_run_id IS NULL` 的手动指标**永不删**——那是用户亲手填的数字）。
 *   · **可关**：`retention.policy.enabled = false` 即完全停用；单项也可单独关。
 *   · **留痕**：每次清理把"删了多少条/多少文件"写进审计（只写计数，不写内容）。
 *   · **不阻塞**：分步、限量（每次最多删 N 行），在启动后与定时器里跑，不与用户操作抢主线程。
 */

import { app } from 'electron'
import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'

export interface RetentionPolicy {
  enabled: boolean
  /** 每个任务保留最近多少次运行的截图工件（0 = 不按此清理） */
  artifactKeepRunsPerTask: number
  /** 每个店铺每个指标保留多少条快照（0 = 不按此清理）；手动录入的快照永不删 */
  snapshotKeepPerStoreMetric: number
  /** 运行历史（task_runs，级联 task_step_results）保留天数（0 = 不按此清理） */
  historyKeepDays: number
  /** 审计日志保留天数（0 = 不按此清理）；合规数据，默认给到 2 年 */
  auditKeepDays: number
  /** 模型用量流水保留天数（0 = 不按此清理） */
  usageKeepDays: number
  /** 经营采集运行记录保留天数（0 = 不按此清理）；每店每 10 分钟一条，是新增的只增不减写入源 */
  salesRunKeepDays: number
  /** 经营采集脱敏证据保留天数（0 = 不按此清理）；排障材料，比运行记录留得更短 */
  salesRawKeepDays: number
  /** 单次清理最多删除的行数（防一次事务把主线程卡住） */
  batchLimit: number
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  enabled: true,
  artifactKeepRunsPerTask: 60,
  snapshotKeepPerStoreMetric: 400,
  historyKeepDays: 365,
  auditKeepDays: 730,
  usageKeepDays: 365,
  salesRunKeepDays: 90,
  salesRawKeepDays: 30,
  batchLimit: 5000
}

export interface RetentionResult {
  skipped?: string
  artifactFiles: number
  snapshots: number
  runs: number
  jobEvents: number
  memoryEvents: number
  auditLogs: number
  usage: number
  orphanPartitions: number
  salesRuns: number
  salesRawEvidence: number
}

/** 读取策略：`app_settings['retention.policy']` 与默认值合并（缺项/解析失败都退回默认） */
export function loadRetentionPolicy(): RetentionPolicy {
  try {
    const row = getDatabase()
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get('retention.policy') as any
    if (!row) return DEFAULT_RETENTION_POLICY
    const raw = JSON.parse(row.value_json) as Partial<RetentionPolicy>
    const out = { ...DEFAULT_RETENTION_POLICY }
    for (const key of Object.keys(DEFAULT_RETENTION_POLICY) as Array<keyof RetentionPolicy>) {
      const value = raw[key]
      if (typeof value === 'boolean' && typeof out[key] === 'boolean') (out[key] as boolean) = value
      else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) (out[key] as number) = Math.trunc(value)
    }
    return out
  } catch {
    return DEFAULT_RETENTION_POLICY
  }
}

/**
 * 截图工件清理：**按任务保留最近 N 次运行**的那些，其余删除文件并把列置 NULL。
 *
 * 为什么按运行次数而不是按天：邀约任务一小时能跑好几轮，按天算的窗口在密集任务下
 * 依然会堆出几十 GB；"最近的 N 次运行"才是用户真会回看的范围。
 * 只置 NULL 不删行：步骤结果本身是运行证据，删行会让"这次运行做过什么"断档。
 */
function pruneArtifacts(policy: RetentionPolicy): number {
  if (policy.artifactKeepRunsPerTask <= 0) return 0
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT r.artifact_path AS path FROM task_step_results r
    WHERE r.artifact_path IS NOT NULL
      AND r.run_id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY rowid DESC) AS rn
          FROM task_runs
        ) WHERE rn <= ?
      )
    LIMIT ?
  `).all(policy.artifactKeepRunsPerTask, policy.batchLimit) as any[]
  if (!rows.length) return 0

  const clear = db.prepare('UPDATE task_step_results SET artifact_path = NULL, artifact_sha256 = NULL WHERE artifact_path = ?')
  let removed = 0
  db.transaction(() => {
    for (const row of rows) {
      const path = String(row.path)
      try { if (existsSync(path)) rmSync(path, { force: true }) } catch { /* 文件被占用/已删都不影响置 NULL */ }
      clear.run(path)
      removed++
    }
  })()
  return removed
}

/**
 * 快照清理：每个店铺每个指标只留最近 N 条。
 *
 * **手动录入的快照（source_run_id IS NULL）永不删** —— 那是用户亲手填的经营数字，
 * 界面专门标了"手动"徽标，删掉等于篡改用户数据。
 */
function pruneSnapshots(policy: RetentionPolicy): number {
  if (policy.snapshotKeepPerStoreMetric <= 0) return 0
  const info = getDatabase().prepare(`
    DELETE FROM store_snapshots WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY store_id, metric ORDER BY rowid DESC) AS rn
        FROM store_snapshots
        WHERE source_run_id IS NOT NULL
      ) WHERE rn > ?
      LIMIT ?
    )
  `).run(policy.snapshotKeepPerStoreMetric, policy.batchLimit)
  return Number(info.changes) || 0
}

/** 按时间窗清理一张表（时间列名与上限都由调用方给，避免拼错列静默失效） */
function pruneByAge(table: string, timeColumn: string, days: number, batchLimit: number): number {
  if (days <= 0) return 0
  const cutoff = Date.now() - days * 86400000
  const info = getDatabase().prepare(`
    DELETE FROM ${table} WHERE rowid IN (
      SELECT rowid FROM ${table} WHERE ${timeColumn} < ? LIMIT ?
    )
  `).run(cutoff, batchLimit)
  return Number(info.changes) || 0
}

/**
 * 孤儿 Chromium 分区目录清理（**只在启动时调**）。
 *
 * 实测：删掉店铺后 `Partitions/store_store_<id>` 不会被删（`clearStorageData` 不清 HTTP 磁盘缓存），
 * 本机已经积了 5 个孤儿目录。启动时库里没有任何店铺的分区目录即为孤儿——此时还没创建任何
 * session，不会有文件句柄占用，删得掉。
 */
export function pruneOrphanStorePartitions(): number {
  try {
    const partRoot = join(app.getPath('userData'), 'Partitions')
    if (!existsSync(partRoot)) return 0
    const known = new Set(
      (getDatabase().prepare('SELECT id FROM stores').all() as any[]).map(r => String(r.id))
    )
    let removed = 0
    for (const name of readdirSync(partRoot)) {
      const m = /^store_store_(.+)$/.exec(name)
      if (!m) continue
      if (known.has(m[1])) continue
      try {
        rmSync(join(partRoot, name), { recursive: true, force: true })
        removed++
      } catch { /* 被占用就留到下次启动再试 */ }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * 经营采集运行记录清理：只删已结束的行，保留最近 N 天。
 *
 * 不删 RUNNING：那是"应用被强杀"的现场，下次启动的收敛要把它们标成 INTERRUPTED，
 * 提前删掉等于把这次事故的证据抹掉。删除时 `sales_metrics_raw` 会随 run_id 外键级联消失。
 */
function pruneSalesRuns(policy: RetentionPolicy): number {
  if (policy.salesRunKeepDays <= 0) return 0
  const cutoff = Date.now() - policy.salesRunKeepDays * 86400000
  const info = getDatabase().prepare(`
    DELETE FROM sales_collection_runs WHERE rowid IN (
      SELECT rowid FROM sales_collection_runs
      WHERE created_at < ? AND status != 'RUNNING'
      LIMIT ?
    )
  `).run(cutoff, policy.batchLimit)
  return Number(info.changes) || 0
}

let running = false

/**
 * 执行一轮保留策略。启动后调一次 + 每 6 小时一次（与自动备份同一个定时器）。
 * 失败不抛给调用方（清理失败不该影响使用），错误落审计便于排查。
 */
export function runRetention(): RetentionResult {
  const empty: RetentionResult = {
    artifactFiles: 0, snapshots: 0, runs: 0, jobEvents: 0, memoryEvents: 0,
    auditLogs: 0, usage: 0, orphanPartitions: 0, salesRuns: 0, salesRawEvidence: 0
  }
  if (running) return { ...empty, skipped: 'running' }
  const policy = loadRetentionPolicy()
  if (!policy.enabled) return { ...empty, skipped: 'disabled' }

  running = true
  const result: RetentionResult = { ...empty }
  try {
    result.orphanPartitions = pruneOrphanStorePartitions()
    result.artifactFiles = pruneArtifacts(policy)
    result.snapshots = pruneSnapshots(policy)
    result.runs = pruneByAge('task_runs', 'created_at', policy.historyKeepDays, policy.batchLimit)
    result.jobEvents = pruneByAge('agent_job_events', 'created_at', policy.historyKeepDays, policy.batchLimit)
    result.memoryEvents = pruneByAge('agent_memory_events', 'created_at', policy.historyKeepDays, policy.batchLimit)
    result.usage = pruneByAge('agent_usage', 'created_at', policy.usageKeepDays, policy.batchLimit)
    result.auditLogs = pruneByAge('audit_logs', 'created_at', policy.auditKeepDays, policy.batchLimit)
    // 经营采集台账：每店每 10 分钟一条，是**新出现的只增不减**写入源（一天 144 条/店）。
    // 运行记录保留期短于任务历史（它是排障材料，不是业务数据），脱敏证据更短。
    // 只删「已结束」的运行：留在 RUNNING 的行由启动收敛处理，删掉会丢诊断线索。
    result.salesRuns = pruneSalesRuns(policy)
    result.salesRawEvidence = pruneByAge('sales_metrics_raw', 'captured_at', policy.salesRawKeepDays, policy.batchLimit)

    const total = result.artifactFiles + result.snapshots + result.runs + result.jobEvents +
      result.memoryEvents + result.auditLogs + result.usage + result.orphanPartitions +
      result.salesRuns + result.salesRawEvidence
    if (total > 0) {
      writeAudit('retention.prune', 'success', { requestId: JSON.stringify(result) })
    }
    return result
  } catch (error: any) {
    try {
      writeAudit('retention.prune', 'failure', { requestId: JSON.stringify({ message: String(error?.message || error).slice(0, 200) }) })
    } catch { /* 审计写失败也不能抛 */ }
    return result
  } finally {
    running = false
  }
}
