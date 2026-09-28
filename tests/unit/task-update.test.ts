import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import {
  ACTIVE_RUN_STATUSES, assertStepsEditable, buildTaskUpdateSet, isActiveRunStatus
} from '../../apps/desktop/src/main/tasks/task-update-rules'

/**
 * task:update 的两条关键规则：
 *   1) 任务有 queued/running/waiting_confirmation/paused 的运行记录时**不允许改 steps**（TASK_BAD_STATE）；
 *   2) 部分更新只写传入的字段，未传的字段保留原值。
 *
 * task-store.ts 自身依赖 SQLite/Electron，纯 Node 下加载不了，所以分两层：
 *   · 纯规则在 task-update-rules.ts 里，任何环境都能测（第一组）；
 *   · 端到端行为用 Node 内置 node:sqlite 建真库、mock 掉 db/audit 两个依赖来测（第二组），
 *     与 migrations.test.ts 同一套做法（node:sqlite 需要 Node >= 22.5，缺失时跳过）。
 */

type SqliteStatement = {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}
type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}
type SqliteCtor = new (path: string) => SqliteDb
type TxDb = SqliteDb & { transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown }

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch {
    return null
  }
}

const DatabaseSyncCtor = loadSqlite()
const realIt = DatabaseSyncCtor ? it : it.skip

// 只有这两处外部依赖需要替换：数据库句柄与审计（审计失败不影响主流程，断言不看它）。
const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => holder.db }))
vi.mock('../../apps/desktop/src/main/services/audit-logger', () => ({ writeAudit: () => {} }))

import { createTask, getTask, updateTask } from '../../apps/desktop/src/main/tasks/task-store'

// ---------- 真库 ----------

/** tasks/task_steps/task_runs/task_step_results 四张表：列与 migrations.ts 保持一致（不带外键，免造 stores）。 */
function createSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, store_scope TEXT, status TEXT NOT NULL,
      schedule_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_fired_at INTEGER
    );
    CREATE TABLE task_steps (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_index INTEGER NOT NULL, type TEXT NOT NULL,
      input_json TEXT NOT NULL, timeout_ms INTEGER NOT NULL, retry_limit INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, store_id TEXT NOT NULL, status TEXT NOT NULL,
      current_step INTEGER, started_at INTEGER, finished_at INTEGER, error_code TEXT,
      error_message TEXT, status_reason TEXT
    );
    CREATE TABLE task_step_results (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT, artifact_path TEXT, artifact_sha256 TEXT, created_at INTEGER NOT NULL
    );
  `)
}

function makeDb(): TxDb {
  const raw = new DatabaseSyncCtor!(':memory:')
  createSchema(raw)
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    close: () => raw.close(),
    // better-sqlite3 的 db.transaction(fn)() 语法：node:sqlite 没有，补最小适配
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      raw.exec('BEGIN')
      try {
        const result = fn(...args)
        raw.exec('COMMIT')
        return result
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    }
  }
}

function db(): TxDb { return holder.db as TxDb }

let runSeq = 0
/** 直接落一条运行记录（不经过 runner）：就是"任务存在某状态的运行"这一前提。 */
function insertRun(taskId: string, status: string): string {
  const runId = `run_test_${++runSeq}`
  db().prepare(
    'INSERT INTO task_runs (id, task_id, store_id, status, current_step, started_at, finished_at, error_code, error_message, status_reason) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(runId, taskId, 'store_1', status, 0, Date.now(), null, null, null, '测试')
  return runId
}

const TWO_STEPS = [
  { type: 'navigate', input: { url: 'https://example.com/a' } },
  { type: 'screenshot', input: {} }
]

/** 捕获同步抛出的错误（用于断言错误类型而不只是消息）。 */
function catchError(fn: () => unknown): unknown {
  try { fn(); return null } catch (e) { return e }
}

beforeEach(() => { holder.db = makeDb() })

// ---------- 1. 纯规则（不依赖 node:sqlite） ----------

describe('运行中改步骤的判定（纯规则）', () => {
  it('四种未结束状态一律拒绝，消息里带当前状态与原因', () => {
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(isActiveRunStatus(status)).toBe(true)
      let message = ''
      try { assertStepsEditable(status) } catch (e: any) { message = String(e?.message) }
      expect(message.startsWith('TASK_BAD_STATE:')).toBe(true)
      expect(message).toContain(status)
      expect(message).toContain('不允许修改任务步骤')
    }
  })

  it('终态与"没有运行"不阻拦改步骤', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', null, undefined]) {
      expect(isActiveRunStatus(status)).toBe(false)
      expect(() => assertStepsEditable(status)).not.toThrow()
    }
  })

  it('部分更新只把传入的列放进 SET（未传字段的原值自然保留）', () => {
    expect(buildTaskUpdateSet({ name: '新名', updatedAt: 7 })).toEqual({
      sets: ['name = ?', 'updated_at = ?'], values: ['新名', 7]
    })
    // 显式 null = 清空，仍要进语句
    expect(buildTaskUpdateSet({ storeScope: null, scheduleJson: null, updatedAt: 7 })).toEqual({
      sets: ['store_scope = ?', 'schedule_json = ?', 'updated_at = ?'], values: [null, null, 7]
    })
    expect(buildTaskUpdateSet({ updatedAt: 7 })).toEqual({ sets: ['updated_at = ?'], values: [7] })
  })
})

// ---------- 2. 端到端（真 SQLite） ----------

describe('updateTask（真实 SQLite）', () => {
  realIt('运行中的任务不能改 steps：抛 TASK_BAD_STATE，且步骤原样不动', () => {
    for (const status of ACTIVE_RUN_STATUSES) {
      const task = createTask({ name: '巡检', storeScope: 'store_1', steps: TWO_STEPS })
      insertRun(task.id, status)

      expect(() => updateTask({
        taskId: task.id, steps: [{ type: 'navigate', input: { url: 'https://example.com/b' } }]
      })).toThrowError(new RegExp(`TASK_BAD_STATE.*${status}`))

      expect(getTask(task.id)!.steps.map(s => (s.input as any).url ?? s.type)).toEqual(['https://example.com/a', 'screenshot'])
    }
  })

  realIt('运行中改名称/店铺/计划是允许的（不涉及被执行的步骤序列）', () => {
    const task = createTask({ name: '巡检', storeScope: 'store_1', schedule: { everyMs: 3600000 }, steps: TWO_STEPS })
    insertRun(task.id, 'running')
    expect(() => updateTask({ taskId: task.id, name: '巡检（只改名）' })).not.toThrow()
  })

  realIt('部分更新保留未传字段（名称之外全都不动）', () => {
    const task = createTask({ name: '巡检', storeScope: 'store_1', schedule: { everyMs: 3600000 }, steps: TWO_STEPS })
    expect(() => updateTask({ taskId: task.id, name: '巡检（每日）' })).not.toThrow()

    const after = getTask(task.id)!
    expect(after.name).toBe('巡检（每日）')
    expect(after.storeScope).toBe('store_1')                    // 未传 → 保留
    expect(after.schedule).toEqual({ everyMs: 3600000 })          // 未传 → 保留
    expect(after.steps.map(s => s.type)).toEqual(['navigate', 'screenshot'])
    expect(after.updatedAt).toBeGreaterThanOrEqual(task.updatedAt)
  })

  realIt('steps 整体替换并重排序号；显式 null 清空计划', () => {
    const task = createTask({ name: '巡检', storeScope: 'store_1', schedule: { everyMs: 3600000 }, steps: TWO_STEPS })

    const after = updateTask({
      taskId: task.id,
      storeScope: null,
      schedule: null,
      steps: [{ type: 'navigate', input: { url: 'https://example.com/c' } }]
    })

    expect(after.storeScope).toBeNull()
    expect(after.schedule).toBeNull()
    expect(after.steps).toHaveLength(1)
    expect(after.steps[0]).toMatchObject({
      index: 0, type: 'navigate', input: { url: 'https://example.com/c' }, timeoutMs: 15000, retryLimit: 0
    })
    expect(getTask(task.id)!.steps).toHaveLength(1)
  })

  realIt('任务不存在 → TASK_NOT_FOUND', () => {
    expect(() => updateTask({ taskId: 'task_missing', name: 'x' })).toThrowError(/TASK_NOT_FOUND/)
  })

  realIt('步骤校验与 createTask 同源：未登记类型/非法 url 依旧被拒', () => {
    const task = createTask({ name: '巡检', steps: TWO_STEPS })

    // 未登记类型：先在**与 createTask 共用的**结构 schema 枚举处被拒（ZodError → taskError 转 TASK_INVALID_STEP）
    const badType: any = catchError(() => updateTask({
      taskId: task.id, steps: [{ type: 'execArbitraryCode', input: {} }]
    }))
    expect(badType?.name).toBe('ZodError')
    expect(String(badType?.message)).toContain('execArbitraryCode')

    // 类型合法但输入非法：走同一份 stepInputSchemas（httpUrl 只放行 http/https）
    expect(() => updateTask({
      taskId: task.id, steps: [{ type: 'navigate', input: { url: 'javascript:alert(1)' } }]
    })).toThrowError(/仅允许 http\/https|Invalid url/)
    // 空步骤列表：与 createTask 一样被 min(1) 拒
    expect(() => updateTask({ taskId: task.id, steps: [] })).toThrowError()
    // 被拒后原步骤仍在（校验先于写库）
    expect(getTask(task.id)!.steps.map(s => s.type)).toEqual(['navigate', 'screenshot'])
  })
})
