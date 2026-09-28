/**
 * 任务定义存储 - §5.6 / §4.4
 * 步骤只允许预定义类型；输入 JSON 一律 Zod 校验（§5.6）；
 * 日志与 payload 只存输入摘要，不存表单完整值（§4.5）。
 * 审计 request_id 列复用为实体引用（JSON），schema 保持 §5.7 七列不动。
 */

import { randomBytes } from 'crypto'
import { getDatabase } from '../db/database'
import { writeAudit } from '../services/audit-logger'
import type {
  TaskCreateInput, TaskStepDef, TaskView, TaskRunView,
  TaskStepResultView, TaskResults, StepResultKind
} from '@shared/schemas/task'
// 步骤白名单 schema 独立成 task-step-schemas.ts（不含 DB/Electron 依赖，单测可直接导入）
export { stepInputSchemas, NON_RESUMABLE_TYPES, normalizeStepRetryLimit, DEFAULT_STEP_TIMEOUT, taskCreateSchema } from './task-step-schemas'
import { stepInputSchemas, taskCreateSchema, DEFAULT_STEP_TIMEOUT, normalizeStepRetryLimit } from './task-step-schemas'
// 更新定义时"运行中能否改步骤""这次 UPDATE 写哪几列"的纯规则（同上，为可单测而独立）
import { ACTIVE_RUN_STATUSES, assertStepsEditable, buildTaskUpdateSet } from './task-update-rules'

function newId(prefix: string): string { return `${prefix}_${randomBytes(12).toString('hex')}` }

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

/**
 * 逐步校验步骤（白名单，§5.6），返回**完整步骤**{ type, input, timeoutMs, retryLimit? }。
 * loop 是复合作步骤：嵌套步骤递归校验（否则"循环体里塞未登记类型"就绕过了白名单），
 * 并补默认 timeoutMs——嵌套步骤此前漏补，运行时拿到 undefined → withTimeout(NaN)
 * （真店实测报「clickByText 超过 NaNms」）。label 把错误定位到具体子步骤（如 3.2）。
 */
function validateStepInput(s: { type: string; input?: unknown; timeoutMs?: number; retryLimit?: number }, label: string): any {
  const schema = stepInputSchemas[s.type]
  if (!schema) throw new Error(`TASK_INVALID_STEP:step ${label} ${s.type}: 未登记的步骤类型`)
  const out = schema.safeParse(s.input ?? {})
  if (!out.success) {
    throw new Error(`TASK_INVALID_STEP:step ${label} ${s.type}: ${out.error.issues.map(x => x.message).join('; ')}`)
  }
  const input = out.data as any
  const timeoutMs = s.timeoutMs ?? (DEFAULT_STEP_TIMEOUT[s.type] ?? 15000)
  // 重试闸：非幂等步骤（click*/loop/门禁/切标签）一律 0——重试等于重复提交。
  // 归一化在落库侧完成，引擎运行侧还有一道同源判定（挡修复前已落库的旧行）。
  const retryLimit = normalizeStepRetryLimit(s.type, s.retryLimit)
  if (s.type === 'loop' && Array.isArray(input?.steps)) {
    input.steps = input.steps.map((child: any, k: number) => validateStepInput(child, `${label}.${k + 1}`))
    // onCode 的恢复步骤同样是"会被执行的步骤"，必须一起过白名单（否则循环恢复里塞未登记类型就绕过了校验）
    if (Array.isArray(input?.onCode)) {
      input.onCode = input.onCode.map((rule: any, r: number) => ({
        ...rule,
        ...(Array.isArray(rule?.steps)
          ? { steps: rule.steps.map((child: any, k: number) => validateStepInput(child, `${label}.r${r + 1}.${k + 1}`)) }
          : {})
      }))
    }
  }
  return { type: s.type, input, timeoutMs, ...(retryLimit > 0 ? { retryLimit } : {}) }
}

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
      const checked = validateStepInput(s, String(i + 1))
      insStep.run(newId('tstep'), taskId, i, checked.type, JSON.stringify(checked.input),
        checked.timeoutMs, checked.retryLimit ?? 0)
    })
  })()

  writeAudit('task.create', 'success', { requestId: JSON.stringify({ taskId, name: parsed.name }) })
  return getTask(taskId)!
}

/**
 * 任务定义**部分更新**（task:update）。
 *
 * 校验与 createTask **同源**，没有第二份规则：
 *   · steps 的结构先走 taskCreateSchema.shape.steps（与 createTask 用的同一个 schema）；
 *   · 每个步骤再走同一个 validateStepInput（白名单 + loop/onCode 递归 + 默认超时）；
 *   · name / storeScope / schedule 也复用 taskCreateSchema 的同名字段 schema。
 * 未传的字段保留原值；显式传 null 表示清空 storeScope / schedule。
 *
 * 运行中可否改字段的策略：**只有 steps 被拒**。名称 / 店铺范围 / 计划都不参与当前这一轮执行——
 * 本次运行在入队时就已快照了 taskName 与 storeId，计划只影响下一次到点触发；
 * 而 steps 被 step_index 引用（current_step、task_step_results、恢复时跳过已成功的下标），
 * 中途替换会让"哪一步已执行"对不上，副作用步骤可能被跳过或重复执行。
 */
export interface TaskUpdateInput {
  taskId: string
  name?: string
  storeScope?: string | null
  /** 与 createTask 相同的步骤形状（比需求里给的字段多一个可选 retryLimit 原样透传，语义不变） */
  steps?: TaskCreateInput['steps']
  schedule?: unknown
}

/** 该任务是否存在未结束的运行（queued/running/waiting_confirmation/paused），有则返回该运行记录。 */
function findActiveRun(db: any, taskId: string): any | null {
  const marks = ACTIVE_RUN_STATUSES.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT * FROM task_runs WHERE task_id = ? AND status IN (${marks}) ORDER BY rowid DESC LIMIT 1`
  ).get(taskId, ...ACTIVE_RUN_STATUSES) as any
  return row ?? null
}

export function updateTask(input: TaskUpdateInput): TaskView {
  const db = getDatabase()
  const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(input.taskId) as any
  if (!exists) throw new Error('TASK_NOT_FOUND')

  // 只有"改步骤"受运行态限制；其余字段在运行中照旧可改（见上面接口注释）
  if (input.steps !== undefined) assertStepsEditable(findActiveRun(db, input.taskId)?.status ?? null)

  // 全部校验都在写库之前做完：非法输入不会留下半更新状态
  const changed: string[] = []
  let name: string | undefined
  let storeScope: string | null | undefined
  let scheduleJson: string | null | undefined
  if (input.name !== undefined) { name = taskCreateSchema.shape.name.parse(input.name); changed.push('name') }
  if (input.storeScope !== undefined) {
    storeScope = taskCreateSchema.shape.storeScope.parse(input.storeScope); changed.push('storeScope')
  }
  if (input.schedule !== undefined) {
    const schedule = taskCreateSchema.shape.schedule.parse(input.schedule)
    scheduleJson = schedule ? JSON.stringify(schedule) : null
    changed.push('schedule')
  }
  // 与 createTask 完全同一条路径：结构 schema → 逐个 validateStepInput（白名单不放宽）
  const steps = input.steps === undefined
    ? undefined
    : taskCreateSchema.shape.steps.parse(input.steps).map((s, i) => validateStepInput(s, String(i + 1)))
  if (steps) changed.push('steps')

  const now = Date.now()
  db.transaction(() => {
    const { sets, values } = buildTaskUpdateSet({ name, storeScope, scheduleJson, updatedAt: now })
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, input.taskId)
    if (steps) {
      // 整体替换（序号从 0 重排）；此处任务没有未结束的运行，不存在下标错位
      db.prepare('DELETE FROM task_steps WHERE task_id = ?').run(input.taskId)
      const insStep = db.prepare(
        'INSERT INTO task_steps (id, task_id, step_index, type, input_json, timeout_ms, retry_limit) VALUES (?,?,?,?,?,?,?)'
      )
      steps.forEach((s, i) => {
        insStep.run(newId('tstep'), input.taskId, i, s.type, JSON.stringify(s.input),
          s.timeoutMs, s.retryLimit ?? 0)
      })
    }
  })()

  writeAudit('task.update', 'success', { requestId: JSON.stringify({ taskId: input.taskId, fields: changed }) })
  return getTask(input.taskId)!
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

/** 调度器专用的轻量列表（**一条 SQL**，只取决定"该不该触发"的字段）。 */
export interface ScheduleCandidate {
  id: string
  status: string
  storeScope: string | null
  schedule: { everyMs?: number } | null
  lastFiredAt: number | null
  latestRunStatus: string | null
}

/**
 * 为什么不能直接用 `listTasks()`：后者是 1 + 3N 次查询（每个任务再查 steps 与最近一次 run），
 * 而调度器**每秒**都要判一次——20 个任务就是 61 次同步 SQLite 查询/秒、7×24 不停，
 * 纯属白烧 CPU/IO（2026-09-28 审查实测）。这里一次查询拿齐全部判据：
 * 相关子查询按 (task_id, rowid DESC) 取最后一行，走 idx_task_runs_task_id。
 */
export function listScheduleCandidates(): ScheduleCandidate[] {
  const rows = getDatabase().prepare(`
    SELECT t.id AS id, t.status AS status, t.store_scope AS store_scope, t.schedule_json AS schedule_json,
           t.last_fired_at AS last_fired_at,
           (SELECT r.status FROM task_runs r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS latest_status
    FROM tasks t
    ORDER BY t.created_at DESC
  `).all() as any[]
  return rows.map(r => ({
    id: r.id,
    status: r.status,
    storeScope: r.store_scope ?? null,
    schedule: r.schedule_json ? (() => { try { return JSON.parse(r.schedule_json) } catch { return null } })() : null,
    lastFiredAt: r.last_fired_at ?? null,
    latestRunStatus: r.latest_status ?? null
  }))
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
