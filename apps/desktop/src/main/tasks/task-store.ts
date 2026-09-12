/**
 * 任务定义存储 - §5.6 / §4.4
 * 步骤只允许预定义类型；输入 JSON 一律 Zod 校验（§5.6）；
 * 日志与 payload 只存输入摘要，不存表单完整值（§4.5）。
 * 审计 request_id 列复用为实体引用（JSON），schema 保持 §5.7 七列不动。
 */

import { randomBytes } from 'crypto'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import { writeAudit } from '../services/audit-logger'
import type {
  TaskCreateInput, TaskStepDef, TaskView, TaskRunView,
  TaskStepResultView, TaskResults, StepResultKind
} from '@shared/schemas/task'
import { TASK_STEP_TYPES } from '@shared/schemas/task'

function newId(prefix: string): string { return `${prefix}_${randomBytes(12).toString('hex')}` }

// ---------- 步骤输入 Zod schema（白名单封闭：不接受任意代码） ----------

const selector = z.string().min(1).max(500)
const httpUrl = z.string().url().refine(
  (u) => /^https?:\/\//i.test(u),
  { message: '仅允许 http/https 导航目标' }
)

export const stepInputSchemas: Record<string, z.ZodSchema> = {
  navigate: z.object({ url: httpUrl }).strict(),
  waitForPage: z.object({ urlIncludes: z.string().max(300).optional() }).strict(),
  waitForSelector: z.object({ selector }).strict(),
  readText: z.object({ selector, metric: z.string().min(1).max(60).optional() }).strict(),
  readTable: z.object({ selector, metric: z.string().min(1).max(60).optional() }).strict(),
  screenshot: z.object({}).strict(),
  fillDraft: z.object({ selector, text: z.string().max(20000) }).strict(),
  waitForUserConfirmation: z.object({ message: z.string().min(1).max(500) }).strict()
}

/** 副作用步骤不可进入"从失败恢复"的重试范围 - §9.2 */
export const NON_RESUMABLE_TYPES: ReadonlySet<string> = new Set(['fillDraft', 'waitForUserConfirmation'])

export const taskCreateSchema = z.object({
  name: z.string().min(1).max(80),
  storeScope: z.string().max(80).nullish(),
  steps: z.array(z.object({
    type: z.enum(TASK_STEP_TYPES as unknown as [string, ...string[]]),
    input: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(500).max(600000).optional(),
    retryLimit: z.number().int().min(0).max(5).optional()
  })).min(1).max(30),
  schedule: z.object({ everyMs: z.number().int().min(60000).max(30 * 86400000) }).nullish()
})

// ---------- 行映射 ----------

function mapStepRow(r: any): TaskStepDef {
  return {
    index: r.step_index,
    type: r.type,
    input: JSON.parse(r.input_json || '{}'),
    timeoutMs: r.timeout_ms,
    retryLimit: r.retry_limit
  }
}

export function mapRunRow(r: any): TaskRunView {
  return {
    id: r.id, taskId: r.task_id, storeId: r.store_id, status: r.status,
    currentStep: r.current_step, startedAt: r.started_at, finishedAt: r.finished_at,
    errorCode: r.error_code, errorMessage: r.error_message, statusReason: r.status_reason ?? null
  }
}

function mapResultRow(r: any): TaskStepResultView {
  const payload = r.payload_json ? JSON.parse(r.payload_json) : null
  return {
    id: r.id, runId: r.run_id, stepIndex: r.step_index, kind: r.kind,
    summary: summarizeResult(r.kind, payload, { path: r.artifact_path, sha256: r.artifact_sha256 }),
    payload, artifactPath: r.artifact_path, artifactSha256: r.artifact_sha256,
    createdAt: r.created_at
  }
}

/** 摘要不复制表单值（§4.5）；读取型结果本身即页面文本，允许摘要展示 */
function summarizeResult(kind: string, payload: any, artifact?: { path?: string | null; sha256?: string | null }): string {
  // 截图步骤的载荷为空、信息全在工件字段：此前先判 !payload 直接返回空串，
  // 导致步骤明细里那一行什么都没显示（用户看不到截图工件）。
  if (kind === 'screenshot') {
    const name = artifact?.path ? String(artifact.path).split(/[\\/]/).pop() : null
    if (!name) return '截图工件'
    const digest = artifact?.sha256 ? ' · ' + String(artifact.sha256).slice(0, 8) : ''
    return `截图工件 ${name}${digest}`
  }
  if (!payload) return ''
  if (kind === 'executed') return '已执行'
  if (kind === 'confirm') return payload.approved ? '用户已确认' : '用户已拒绝'
  if (kind === 'text') return String(payload.text ?? (payload.filled ? `已填充 ${(payload.length ?? 0)} 字符` : '')).slice(0, 120)
  if (kind === 'table') return `${(payload.rows || []).length} 行 × ${(payload.rows || [])[0]?.length ?? 0} 列`
  return ''
}

// ---------- CRUD ----------

export function createTask(input: TaskCreateInput): TaskView {
  const parsed = taskCreateSchema.parse(input) // 抛错由 handler 转 TASK_INVALID_STEP
  const db = getDatabase()
  const now = Date.now()
  const taskId = newId('task')

  db.transaction(() => {
    db.prepare(
      'INSERT INTO tasks (id, name, store_scope, status, schedule_json, last_fired_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(taskId, parsed.name, parsed.storeScope ?? null, 'active',
      parsed.schedule ? JSON.stringify(parsed.schedule) : null, null, now, now)

    const insStep = db.prepare(
      'INSERT INTO task_steps (id, task_id, step_index, type, input_json, timeout_ms, retry_limit) VALUES (?,?,?,?,?,?,?)'
    )
    parsed.steps.forEach((s, i) => {
      const schema = stepInputSchemas[s.type]
      const out = schema.safeParse(s.input ?? {})
      if (!out.success) {
        throw new Error(`TASK_INVALID_STEP:step ${i + 1} ${s.type}: ${out.error.issues.map(x => x.message).join('; ')}`)
      }
      insStep.run(newId('tstep'), taskId, i, s.type, JSON.stringify(out.data),
        s.timeoutMs ?? (s.type === 'waitForUserConfirmation' ? 3600000 : 15000), s.retryLimit ?? 0)
    })
  })()

  writeAudit('task.create', 'success', { requestId: JSON.stringify({ taskId, name: parsed.name }) })
  return getTask(taskId)!
}

export function getTask(taskId: string): TaskView | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any
  if (!row) return null
  const steps = (db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index').all(taskId) as any[]).map(mapStepRow)
  const latest = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as any
  return {
    id: row.id, name: row.name, storeScope: row.store_scope, status: row.status,
    schedule: row.schedule_json ? JSON.parse(row.schedule_json) : null,
    lastFiredAt: row.last_fired_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    steps, latestRun: latest ? mapRunRow(latest) : null
  }
}

export function listTasks(): TaskView[] {
  const db = getDatabase()
  return (db.prepare('SELECT id FROM tasks ORDER BY created_at DESC').all() as any[]).map(r => getTask(r.id)!).filter(Boolean)
}

export function getSteps(taskId: string): TaskStepDef[] {
  const db = getDatabase()
  return (db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index').all(taskId) as any[]).map(mapStepRow)
}

export function setTaskStatus(taskId: string, status: string): void {
  getDatabase().prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), taskId)
}

export function setLastFired(taskId: string, ts: number): void {
  getDatabase().prepare('UPDATE tasks SET last_fired_at = ? WHERE id = ?').run(ts, taskId)
}

export function deleteTask(taskId: string): void {
  const db = getDatabase()
  writeAudit('task.delete', 'success', { requestId: JSON.stringify({ taskId }) })
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId) // steps/runs 级联；step_results 随 runs 级联
}

// ---------- runs ----------

export function createRun(taskId: string, storeId: string, reason: string): TaskRunView {
  const db = getDatabase()
  const id = newId('run')
  db.prepare(
    'INSERT INTO task_runs (id, task_id, store_id, status, current_step, started_at, finished_at, error_code, error_message, status_reason) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, taskId, storeId, 'queued', null, null, null, null, null, reason)
  return getRun(id)!
}

export function getRun(runId: string): TaskRunView | null {
  const row = getDatabase().prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as any
  return row ? mapRunRow(row) : null
}

export function updateRun(runId: string, fields: Partial<{ status: string; currentStep: number | null; startedAt: number | null; finishedAt: number | null; errorCode: string | null; errorMessage: string | null; statusReason: string | null }>): void {
  const db = getDatabase()
  const map: Record<string, string> = {
    status: 'status', currentStep: 'current_step', startedAt: 'started_at',
    finishedAt: 'finished_at', errorCode: 'error_code', errorMessage: 'error_message', statusReason: 'status_reason'
  }
  const sets: string[] = [], vals: any[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (map[k]) { sets.push(`${map[k]} = ?`); vals.push(v) }
  }
  if (!sets.length) return
  db.prepare(`UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, runId)
}

// ---------- step results / snapshots ----------

export function insertStepResult(runId: string, stepIndex: number, kind: StepResultKind | 'confirm' | 'executed', payload: unknown, artifact?: { path: string; sha256: string }): string {
  const db = getDatabase()
  const id = newId('tres')
  db.prepare(
    'INSERT INTO task_step_results (id, run_id, step_index, kind, payload_json, artifact_path, artifact_sha256, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, runId, stepIndex, kind, payload ? JSON.stringify(payload) : null,
    artifact?.path ?? null, artifact?.sha256 ?? null, Date.now())
  return id
}

export function listStepResults(runId: string): TaskStepResultView[] {
  const db = getDatabase()
  return (db.prepare('SELECT * FROM task_step_results WHERE run_id = ? ORDER BY step_index').all(runId) as any[]).map(mapResultRow)
}

export function insertSnapshot(storeId: string, metric: string, value: unknown, sourceRunId: string | null): void {
  getDatabase().prepare(
    'INSERT INTO store_snapshots (id, store_id, metric, value_json, source_run_id, captured_at) VALUES (?,?,?,?,?,?)'
  ).run(newId('snap'), storeId, metric, JSON.stringify(value), sourceRunId, Date.now())
}

export function getResults(runId: string): TaskResults | null {
  const run = getRun(runId)
  if (!run) return null
  return { run, steps: getSteps(run.taskId), results: listStepResults(runId) }
}

/** 某 run 已成功执行的步骤索引（从失败恢复时跳过，不重复执行 - §9.2） */
export function succeededStepIndexes(runId: string): Set<number> {
  const db = getDatabase()
  const rows = db.prepare('SELECT DISTINCT step_index FROM task_step_results WHERE run_id = ?').all(runId) as any[]
  return new Set(rows.map(r => r.step_index))
}

/** 店铺指标快照（§5.11，供概览页与环境面板展示） */
export function listSnapshots(storeId: string, limit = 20): Array<{ id: string; metric: string; value: unknown; sourceRunId: string | null; capturedAt: number }> {
  const db = getDatabase()
  return (db.prepare(
    'SELECT * FROM store_snapshots WHERE store_id = ? ORDER BY captured_at DESC LIMIT ?'
  ).all(storeId, limit) as any[]).map(r => ({
    id: r.id, metric: r.metric, value: JSON.parse(r.value_json),
    sourceRunId: r.source_run_id, capturedAt: r.captured_at
  }))
}
