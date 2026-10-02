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
    CREATE TABLE store_snapshots (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source_run_id TEXT,
      captured_at INTEGER NOT NULL
    );
    -- v15（hot_query_indexes）会给这两张表补索引，真实 v3 库里它们由 v1/v5 建好，
    -- 夹具必须一并造出来（否则"旧库升级"用例会在一个现实中不存在的半成品库上跑）
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      store_id TEXT,
      request_id TEXT,
      detail_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_usage (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations (version, name, applied_at) VALUES
      (1, 'initial_schema', 0),
      (2, 'task_engine_columns', 0),
      (3, 'store_license_columns', 0);
  `)
  return db
}

describe('数据库迁移', () => {
  it('迁移链连续、命名稳定，且最新版本跟随代码（不再硬编码版本号）', () => {
    const versions = migrations.map(migration => migration.version)
    // 严格递增且不跳号：跳号通常意味着历史迁移被改动，老库会漏升级。
    expect(versions).toEqual(versions.map((_, index) => index + 1))
    expect(migrations[migrations.length - 1].version).toBe(versions.length)
    // 记忆治理链必须都在：v9 上下文窗口 / v10 自动学习 / v11 近重复指纹
    expect(migrations.find(m => m.version === 9)?.name).toBe('agent_model_context_window')
    expect(migrations.find(m => m.version === 10)?.name).toBe('agent_memory_learning_governance')
    expect(migrations.find(m => m.version === 11)?.name).toBe('agent_memory_dedupe')
  })

  it('v4 全部语句都带 IF NOT EXISTS（可安全重复执行）', () => {
    const migration = migrations.find(x => x.version === 4)!
    const statements: string[] = []
    migration.up({ exec: (sql: string) => { statements.push(sql) } } as unknown as MigrationDb)
    expect(statements).toHaveLength(2)
    expect(statements.every(sql => sql.includes('IF NOT EXISTS'))).toBe(true)
  })

  realDbIt('v19 商品域建表：表/索引/关键约束都在，且可重复执行（真实 SQLite）', () => {
    const db = new DatabaseSyncCtor(':memory:')
    apply(db, 19)

    const TABLES = [
      'products', 'product_variants', 'product_media',
      'product_platform_links', 'product_sku_links', 'product_platform_defaults',
      'product_sync_runs', 'product_publish_jobs', 'product_publish_items'
    ]
    const tableNames = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map(row => row.name)
    for (const table of TABLES) expect(tableNames, table).toContain(table)

    // 索引：每条都是某个真实查询路径的支撑（见方案 §4.9），漏一个就会退化成全表扫
    expect(indexNames(db, 'product_platform_links')).toEqual(expect.arrayContaining(['idx_ppl_product', 'idx_ppl_store', 'idx_ppl_orphan']))
    expect(indexNames(db, 'product_sku_links')).toEqual(expect.arrayContaining(['idx_sku_links_link', 'idx_sku_links_variant']))
    expect(indexNames(db, 'product_media')).toEqual(expect.arrayContaining(['idx_media_sha', 'idx_media_product', 'idx_media_state']))
    expect(indexNames(db, 'product_sync_runs')).toContain('idx_sync_runs_store')
    expect(indexNames(db, 'product_publish_items')).toEqual(expect.arrayContaining(['idx_publish_items_pending', 'idx_publish_items_job']))

    // 重复执行必须安全（老库/重跑都不该炸）
    expect(() => apply(db, 19)).not.toThrow()
    db.close()
  })

  realDbIt('v19 的两条核心不变式：平台商品唯一、已归并的本地商品在同店只允许一条（真实 SQLite）', () => {
    const db = new DatabaseSyncCtor(':memory:')
    // 只跑 v19 时 stores 还不存在（它是更早的迁移建的）；这里补一张最小表，专注验证商品域的约束
    db.exec(`CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);`)
    apply(db, 19)
    db.exec(`
      INSERT INTO stores (id, name, platform, created_at, updated_at) VALUES ('s1', '店', '微信小店', 0, 0);
      INSERT INTO products (id, title, draft_hash, created_at, updated_at) VALUES ('p1', '商品一', 'h1', 0, 0), ('p2', '商品二', 'h2', 0, 0);
    `)
    const insertLink = (id: string, productId: string | null, platformProductId: string): void => {
      db.prepare(`
        INSERT INTO product_platform_links (id, product_id, platform, store_id, platform_product_id, first_seen_at, collected_at)
        VALUES (?, ?, '微信小店', 's1', ?, 0, 0)
      `).run(id, productId, platformProductId)
    }

    // ① 未归并的可以有很多条（product_id 为 NULL，SQLite 唯一索引不约束 NULL）
    expect(() => { insertLink('l1', null, 'A'); insertLink('l2', null, 'B') }).not.toThrow()
    // ② 同一个平台商品不能重复落库（同步幂等的根基）：l1 已经占了 ('s1','A')
    expect(() => insertLink('l3', 'p1', 'A')).toThrow()
    // ③ 先把 C 归给 p1（合法），再想把 D 也归给 p1 → 必须抛
    //    （防"发重了"被当成两条合法记录：同一店铺里一个本地商品只能对一个平台商品）
    expect(() => insertLink('l4', 'p1', 'C')).not.toThrow()
    expect(() => insertLink('l5', 'p1', 'D')).toThrow()
    // ④ 换成另一个本地商品就合法
    expect(() => insertLink('l6', 'p2', 'D')).not.toThrow()

    // ⑤ 软删语义：products.deleted_at 存在（硬删会把发布台账级联掉）
    const productColumns = (db.prepare(`PRAGMA table_info(products)`).all() as Array<{ name: string }>).map(c => c.name)
    expect(productColumns).toContain('deleted_at')

    db.close()
  })

  realDbIt('v19 可回滚：down 之后商品表全部消失，且不触碰其它域（真实 SQLite）', () => {
    const db = new DatabaseSyncCtor(':memory:')
    apply(db, 12)          // 先建一个别的域的表，验证回滚不误伤
    apply(db, 19)
    const migration = migrations.find(m => m.version === 19)!
    migration.down(db as unknown as MigrationDb)

    const tableNames = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map(row => row.name)
    for (const table of ['products', 'product_variants', 'product_media', 'product_platform_links',
      'product_sku_links', 'product_platform_defaults', 'product_sync_runs', 'product_publish_jobs', 'product_publish_items']) {
      expect(tableNames, table).not.toContain(table)
    }
    // 订单域（v12）必须原样留着 —— 回滚只能动自己的东西
    expect(tableNames).toContain('orders')
    db.close()
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

  realDbIt('生产 migrate() 能把 v3 旧库自动升到最新版本并补索引、写 Agent 台账（真实 SQLite）', () => {
    const db = createLegacyV3Database()
    const shim = withTransactionShim(db)
    expect(getCurrentVersion(shim as MigrationDb)).toBe(3)

    expect(() => migrate(shim as MigrationDb)).not.toThrow()

    const latestVersion = migrations[migrations.length - 1].version
    expect(getCurrentVersion(shim as MigrationDb)).toBe(latestVersion)
    expect(indexNames(db, 'task_runs')).toContain('idx_task_runs_status')
    expect(indexNames(db, 'task_step_results')).toContain('idx_task_step_results_run_step')

    const applied = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 4')
      .all() as Array<{ version: number; name: string }>
    expect(applied).toEqual([{ version: 4, name: 'task_query_indexes' }])

    const agentMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 5')
      .all() as Array<{ version: number; name: string }>
    expect(agentMigration).toEqual([{ version: 5, name: 'agent_runtime_baseline' }])
    const agentJobMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 6')
      .all() as Array<{ version: number; name: string }>
    expect(agentJobMigration).toEqual([{ version: 6, name: 'agent_job_confirmation_and_leases' }])
    const agentPricingMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 7')
      .all() as Array<{ version: number; name: string }>
    expect(agentPricingMigration).toEqual([{ version: 7, name: 'agent_model_pricing' }])
    const agentSkillMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 8')
      .all() as Array<{ version: number; name: string }>
    expect(agentSkillMigration).toEqual([{ version: 8, name: 'agent_skills_and_plugins' }])
    const agentContextMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 9')
      .all() as Array<{ version: number; name: string }>
    expect(agentContextMigration).toEqual([{ version: 9, name: 'agent_model_context_window' }])
    const agentMemoryMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 10')
      .all() as Array<{ version: number; name: string }>
    expect(agentMemoryMigration).toEqual([{ version: 10, name: 'agent_memory_learning_governance' }])
    const agentMemoryDedupeMigration = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 11')
      .all() as Array<{ version: number; name: string }>
    expect(agentMemoryDedupeMigration).toEqual([{ version: 11, name: 'agent_memory_dedupe' }])
    // v11 的真实列与索引必须落到旧库上（防迁移写错列名/漏建索引）
    const memoryColumns = (db.prepare('PRAGMA table_info(agent_memory_records)').all() as Array<{ name: string }>).map(c => c.name)
    expect(memoryColumns).toContain('dedupe_key')
    expect(memoryColumns).toContain('repeat_count')
    expect(indexNames(db, 'agent_memory_records')).toContain('idx_agent_memory_dedupe')

    // 幂等：再跑一次不会重复插入或报错
    expect(() => migrate(shim as MigrationDb)).not.toThrow()
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 8').get() as { n: number }
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
    const profileColumns = (db.prepare('PRAGMA table_info(agent_model_profiles)').all() as Array<{ name: string }>).map(c => c.name)
    expect(profileColumns.filter(c => c === 'pricing_json')).toHaveLength(1)
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
