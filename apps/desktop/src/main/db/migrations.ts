/**
 * 数据库初始化与迁移管理
 * §5 数据模型 + §20 数据迁移
 * 
 * 采用手写迁移系统，不依赖外部工具
 */

export interface Migration {
  version: number
  name: string
  up: (db: any) => void
  down: (db: any) => void
}

/**
 * 所有迁移按版本号排序
 * §5 前言：PRAGMA foreign_keys=ON + WAL
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      // 注意：PRAGMA（foreign_keys / journal_mode）不能在事务内执行，
      // 由 database.ts 在建立连接时（事务外）统一设置，这里只做 DDL。

      // schema_migrations 表 - §20
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `)

      // stores 表 - §5.1
      db.exec(`
        CREATE TABLE stores (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          admin_url TEXT NOT NULL,
          status TEXT NOT NULL,
          avatar_color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          group_name TEXT,
          external_code TEXT,
          owner TEXT,
          region TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          notes TEXT,
          last_active_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        )
      `)

      db.exec('CREATE INDEX idx_stores_status ON stores(status)')
      db.exec('CREATE INDEX idx_stores_deleted_at ON stores(deleted_at)')
      db.exec('CREATE INDEX idx_stores_sort_order ON stores(sort_order)')

      // browser_profiles 表 - §5.2
      db.exec(`
        CREATE TABLE browser_profiles (
          id TEXT PRIMARY KEY,
          store_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          browser_version TEXT NOT NULL,
          os_display TEXT NOT NULL,
          user_agent TEXT NOT NULL,
          ua_client_hints_json TEXT,
          language TEXT NOT NULL,
          timezone TEXT NOT NULL,
          screen_width INTEGER NOT NULL,
          screen_height INTEGER NOT NULL,
          color_depth INTEGER,
          hardware_concurrency INTEGER,
          webgl_vendor TEXT,
          webgl_renderer TEXT,
          profile_partition TEXT UNIQUE NOT NULL,
          config_version INTEGER NOT NULL DEFAULT 1,
          config_digest TEXT NOT NULL,
          profile_schema_version INTEGER NOT NULL DEFAULT 1,
          locked INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_browser_profiles_store_id ON browser_profiles(store_id)')

      // proxies 表 - §5.3
      db.exec(`
        CREATE TABLE proxies (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          username_ref TEXT,
          password_ref TEXT,
          label TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          expires_at INTEGER,
          status TEXT NOT NULL,
          last_ip TEXT,
          last_latency_ms INTEGER,
          last_checked_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // proxy_checks 表 - §5.3.1
      db.exec(`
        CREATE TABLE proxy_checks (
          id TEXT PRIMARY KEY,
          proxy_id TEXT NOT NULL,
          ok INTEGER NOT NULL,
          http_status INTEGER,
          latency_ms INTEGER,
          exit_ip TEXT,
          geo_country TEXT,
          error_code TEXT,
          checked_at INTEGER NOT NULL,
          FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_proxy_checks_proxy_id ON proxy_checks(proxy_id, checked_at DESC)')

      // store_proxies 表 - §5.4
      db.exec(`
        CREATE TABLE store_proxies (
          store_id TEXT PRIMARY KEY,
          proxy_id TEXT,
          mode TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
          FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
        )
      `)

      // tabs 表 - §5.5
      db.exec(`
        CREATE TABLE tabs (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          order_index INTEGER NOT NULL,
          last_active_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_tabs_store_id ON tabs(store_id, order_index)')

      // bookmarks 表 - §5.8
      db.exec(`
        CREATE TABLE bookmarks (
          id TEXT PRIMARY KEY,
          store_id TEXT,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          order_index INTEGER NOT NULL,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_bookmarks_store_id ON bookmarks(store_id)')

      // downloads 表 - §5.9
      db.exec(`
        CREATE TABLE downloads (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          page_url TEXT,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          size_bytes INTEGER,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_downloads_store_id ON downloads(store_id, created_at DESC)')

      // tasks 表 - §5.6
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          store_scope TEXT,
          status TEXT NOT NULL,
          schedule_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // task_steps 表 - §5.6
      db.exec(`
        CREATE TABLE task_steps (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          type TEXT NOT NULL,
          input_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL,
          retry_limit INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_task_steps_task_id ON task_steps(task_id, step_index)')

      // task_runs 表 - §5.6
      db.exec(`
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
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_task_runs_task_id ON task_runs(task_id)')
      db.exec('CREATE INDEX idx_task_runs_store_id ON task_runs(store_id)')

      // task_step_results 表 - §5.10
      db.exec(`
        CREATE TABLE task_step_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT,
          artifact_path TEXT,
          artifact_sha256 TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_task_step_results_run_id ON task_step_results(run_id)')

      // store_snapshots 表 - §5.11
      db.exec(`
        CREATE TABLE store_snapshots (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          metric TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_run_id TEXT,
          captured_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        )
      `)

      db.exec('CREATE INDEX idx_store_snapshots_store_id ON store_snapshots(store_id, metric, captured_at DESC)')

      // audit_logs 表 - §5.7
      db.exec(`
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          store_id TEXT,
          action TEXT NOT NULL,
          result TEXT NOT NULL,
          request_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
        )
      `)

      db.exec('CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC)')
      db.exec('CREATE INDEX idx_audit_logs_store_id ON audit_logs(store_id)')

      // backups 表 - §5.7
      db.exec(`
        CREATE TABLE backups (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          restore_status TEXT
        )
      `)

      // app_settings 表 - §5.7
      db.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    },
    down: (db) => {
      const tables = [
        'app_settings',
        'backups',
        'audit_logs',
        'store_snapshots',
        'task_step_results',
        'task_runs',
        'task_steps',
        'tasks',
        'downloads',
        'bookmarks',
        'tabs',
        'store_proxies',
        'proxy_checks',
        'proxies',
        'browser_profiles',
        'stores',
        'schema_migrations'
      ]
      
      tables.forEach(table => {
        db.exec(`DROP TABLE IF EXISTS ${table}`)
      })
    }
  },
  {
    // M3 任务引擎补充列 - §9.2「迁移原因需持久化」+ §4.4 Scheduler 幂等
    version: 2,
    name: 'task_engine_columns',
    up: (db) => {
      db.exec(`ALTER TABLE task_runs ADD COLUMN status_reason TEXT`)
      db.exec(`ALTER TABLE tasks ADD COLUMN last_fired_at INTEGER`)
    },
    down: (db) => {
      // SQLite 3.35+ 支持 DROP COLUMN；本项目仅前进使用
      db.exec(`ALTER TABLE task_runs DROP COLUMN status_reason`)
      db.exec(`ALTER TABLE tasks DROP COLUMN last_fired_at`)
    }
  },
  {
    // 店铺营业执照：发票要按**开票主体**分账，同一个执照下常挂多家店。
    // 两个字段都可空（老店铺没有就是"未填写"，发票中心会单独列出来提醒补录，不硬塞默认值）。
    // 这里用 ALTER 而不是改上面建表语句：建表语句只在全新库跑一次，
    // 两边都写会让新库在本次迁移上报 duplicate column。
    version: 3,
    name: 'store_license_columns',
    up: (db) => {
      db.exec(`ALTER TABLE stores ADD COLUMN license_name TEXT`)
      db.exec(`ALTER TABLE stores ADD COLUMN license_no TEXT`)
    },
    down: (db) => {
      db.exec(`ALTER TABLE stores DROP COLUMN license_name`)
      db.exec(`ALTER TABLE stores DROP COLUMN license_no`)
    }
  }
]

/**
 * 获取当前数据库版本
 */
export function getCurrentVersion(db: any): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
    return row?.version || 0
  } catch {
    return 0
  }
}

/**
 * 执行迁移
 */
export function migrate(db: any, targetVersion?: number): void {
  const currentVersion = getCurrentVersion(db)
  const target = targetVersion ?? migrations[migrations.length - 1].version

  if (currentVersion >= target) {
    return
  }

  const toApply = migrations.filter(m => m.version > currentVersion && m.version <= target)

  for (const migration of toApply) {
    console.log(`Applying migration ${migration.version}: ${migration.name}`)
    
    db.transaction(() => {
      migration.up(db)
      
      db.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, Date.now())
    })()

    console.log(`Migration ${migration.version} applied successfully`)
  }
}
