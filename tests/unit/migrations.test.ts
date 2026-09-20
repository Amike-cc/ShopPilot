import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { getCurrentVersion, migrate, migrations } from '../../apps/desktop/src/main/db/migrations'

// 迁移函数只依赖 exec()/prepare()，所以可以用 Node 内置的 node:sqlite 在真实数据库上验证。
// 不用 better-sqlite3：它在本仓库里是为 Electron ABI 编译的，纯 Node 下加载会 ERR_DLOPEN_FAILED。
type MigrationDb = Parameters<(typeof migrations)[number]['up']>[0]

/** node:sqlite / better-sqlite3 在本测试里用到的公共子集。 */
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteCtor = new (path: string) => SqliteDb

// 必须走 createRequire：Vite 会剥掉 "node:" 前缀导致 import('node:sqlite') 解析失败。
// node:sqlite 需要 Node >= 22.5；缺失时退化为只校验 SQL 文本，不让整套单测挂掉。
function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch {
    return null
  }
}

const DatabaseSyncCtor = loadSqlite()
const realDbIt = DatabaseSyncCtor ? it : it.skip

function apply(db: SqliteDb, version: number): void {
  const migration = migrations.find(m => m.version === version)
  if (!migration) throw new Error(`缺少 v${version} 迁移`)
  migration.up(db as MigrationDb)
}

function indexNames(db: SqliteDb, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`)
    .all(table) as Array<{ name: string }>
  return rows.map(r => r.name)
}

// migrate() 用到 better-sqlite3 的 db.transaction(fn)() 语法；node:sqlite 没有，
// 这里补一层最小适配，让测试能走真实 migrate() 代码路径（含 schema_migrations 记账）。
function withTransactionShim(db: SqliteDb): SqliteDb & { transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown } {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      db.exec('BEGIN')
      try {
        const result = fn(...args)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

/** 复刻"已升到 v3 但还没跑 v4"的旧库：任务表存在，缺两个查询索引。 */
function createLegacyV3Database(): SqliteDb {
  const db = new DatabaseSyncCtor(':memory:')
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      status_reason TEXT
    );
    CREATE TABLE task_step_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT,
      artifact_path TEXT,
      artifact_sha256 TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_task_runs_task_id ON task_runs(task_id);
    CREATE INDEX idx_task_runs_store_id ON task_runs(store_id);
    CREATE INDEX idx_task_step_results_run_id ON task_step_results(run_id);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES
      (1, 'initial_schema', 0),
      (2, 'task_engine_columns', 0),
      (3, 'store_license_columns', 0);
  `)
  return db
}

describe('数据库迁移', () => {
  it('v4 迁移存在且是最新版本', () => {
    const latest = migrations[migrations.length - 1]
    expect(latest.version).toBe(4)
    expect(latest.name).toBe('task_query_indexes')
  })

  it('v4 全部语句都带 IF NOT EXISTS（可安全重复执行）', () => {
    const migration = migrations.find(x => x.version === 4)!
    const statements: string[] = []
    migration.up({ exec: (sql: string) => { statements.push(sql) } } as unknown as MigrationDb)
    expect(statements).toHaveLength(2)
    expect(statements.every(sql => sql.includes('IF NOT EXISTS'))).toBe(true)
  })

  realDbIt('旧库升到 v3 后缺任务查询索引，v4 会补齐（真实 SQLite）', () => {
    const db = createLegacyV3Database()
    expect(indexNames(db, 'task_runs')).not.toContain('idx_task_runs_status')
    expect(indexNames(db, 'task_step_results')).not.toContain('idx_task_step_results_run_step')

    apply(db, 4)

    expect(indexNames(db, 'task_runs')).toContain('idx_task_runs_status')
    expect(indexNames(db, 'task_step_results')).toContain('idx_task_step_results_run_step')
    // 重复执行 v4 不能因为索引已存在而失败
    expect(() => apply(db, 4)).not.toThrow()
    db.close()
  })

  realDbIt('生产 migrate() 能把 v3 旧库自动升到 v4 并补索引、写台账（真实 SQLite）', () => {
    const db = createLegacyV3Database()
    const shim = withTransactionShim(db)
    expect(getCurrentVersion(shim as MigrationDb)).toBe(3)

    expect(() => migrate(shim as MigrationDb)).not.toThrow()

    expect(getCurrentVersion(shim as MigrationDb)).toBe(4)
    expect(indexNames(db, 'task_runs')).toContain('idx_task_runs_status')
    expect(indexNames(db, 'task_step_results')).toContain('idx_task_step_results_run_step')

    const applied = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 4')
      .all() as Array<{ version: number; name: string }>
    expect(applied).toEqual([{ version: 4, name: 'task_query_indexes' }])

    // 幂等：再跑一次不会重复插入或报错
    expect(() => migrate(shim as MigrationDb)).not.toThrow()
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4').get() as { n: number }
    expect(rows.n).toBe(1)
    db.close()
  })

  realDbIt('全新库按 v1→v4 顺序执行能建出索引且不重复建列（真实 SQLite）', () => {
    const db = new DatabaseSyncCtor(':memory:')
    expect(() => {
      for (const migration of migrations) migration.up(db as MigrationDb)
    }).not.toThrow()

    expect(indexNames(db, 'task_runs')).toEqual(
      expect.arrayContaining(['idx_task_runs_task_id', 'idx_task_runs_store_id', 'idx_task_runs_status'])
    )
    expect(indexNames(db, 'task_step_results')).toEqual(
      expect.arrayContaining(['idx_task_step_results_run_id', 'idx_task_step_results_run_step'])
    )

    const storeColumns = (db.prepare('PRAGMA table_info(stores)').all() as Array<{ name: string }>).map(c => c.name)
    expect(storeColumns.filter(c => c === 'license_name')).toHaveLength(1)
    expect(storeColumns.filter(c => c === 'license_no')).toHaveLength(1)

    const runColumns = (db.prepare('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>).map(c => c.name)
    expect(runColumns.filter(c => c === 'status_reason')).toHaveLength(1)
    db.close()
  })

  realDbIt('索引列与查询实际用到的列一致（防索引写错列）', () => {
    const db = createLegacyV3Database()
    apply(db, 4)

    const runIndexCols = (db.prepare('PRAGMA index_info(idx_task_runs_status)').all() as Array<{ name: string }>).map(c => c.name)
    expect(runIndexCols).toEqual(['status', 'task_id'])

    const stepIndexCols = (db.prepare('PRAGMA index_info(idx_task_step_results_run_step)').all() as Array<{ name: string }>).map(c => c.name)
    expect(stepIndexCols).toEqual(['run_id', 'step_index'])
    db.close()
  })
})
