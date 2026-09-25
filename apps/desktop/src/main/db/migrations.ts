/**
 * 数据库初始化与迁移管理
 * §5 数据模型 + §20 数据迁移
 * 
 * 采用手写迁移系统，不依赖外部工具
 */

import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
  down: (db: Database.Database) => void
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
      db.exec('CREATE INDEX idx_task_runs_status ON task_runs(status, task_id)')

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
      db.exec('CREATE INDEX idx_task_step_results_run_step ON task_step_results(run_id, step_index)')

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
  },
  {
    // 为已经存在的 v1-v3 数据库补齐任务查询索引。
    // 这些索引虽然也写在初始建表迁移里，但旧库不会重新执行 v1；
    // IF NOT EXISTS 兼容已经由新 v1 创建过索引的全新数据库。
    version: 4,
    name: 'task_query_indexes',
    up: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status, task_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_step_results_run_step ON task_step_results(run_id, step_index)')
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_task_step_results_run_step')
      db.exec('DROP INDEX IF EXISTS idx_task_runs_status')
    }
  },
  {
    version: 5,
    name: 'agent_runtime_baseline',
    up: (db) => {
      // A-M0 multi-agent contract.  JSON columns are deliberately opaque to
      // SQLite; Main validates and normalises every value before writing it.
      // A small legacy fixture used by migration tests (and a damaged v3
      // database) may not have reached the original app_settings table yet;
      // creating it here keeps the upgrade path forward-only and idempotent.
      db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('probation','active','paused','retired')),
          prompt_version TEXT NOT NULL,
          model_profile_id TEXT,
          tool_policy_json TEXT NOT NULL,
          store_scope_json TEXT NOT NULL,
          memory_scope_json TEXT NOT NULL,
          success_criteria_json TEXT NOT NULL,
          max_concurrency INTEGER NOT NULL CHECK(max_concurrency BETWEEN 1 AND 32),
          daily_budget_json TEXT,
          timeout_ms INTEGER NOT NULL DEFAULT 120000,
          created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          retired_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
        CREATE INDEX IF NOT EXISTS idx_agents_model ON agents(model_profile_id);

        CREATE TABLE IF NOT EXISTS agent_model_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          model TEXT NOT NULL,
          credential_ref TEXT,
          temperature REAL NOT NULL DEFAULT 0.7,
          max_tokens INTEGER NOT NULL DEFAULT 1200,
          timeout_ms INTEGER NOT NULL DEFAULT 30000,
          fallback_profile_id TEXT REFERENCES agent_model_profiles(id) ON DELETE SET NULL,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          concurrency_limit INTEGER NOT NULL DEFAULT 1,
          daily_budget_json TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          health TEXT NOT NULL DEFAULT 'unknown',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_models_enabled ON agent_model_profiles(enabled);

        CREATE TABLE IF NOT EXISTS agent_model_bindings (
          agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
          model_profile_id TEXT NOT NULL REFERENCES agent_model_profiles(id),
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_bindings_profile ON agent_model_bindings(model_profile_id);

        CREATE TABLE IF NOT EXISTS agent_jobs (
          id TEXT PRIMARY KEY,
          parent_job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
          created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
          assigned_agent_id TEXT NOT NULL REFERENCES agents(id),
          browser_task_id TEXT,
          browser_run_id TEXT,
          store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
          goal TEXT NOT NULL,
          input_summary_json TEXT NOT NULL,
          permission_snapshot_json TEXT NOT NULL,
          store_scope_snapshot_json TEXT NOT NULL,
          memory_scope_snapshot_json TEXT NOT NULL,
          model_snapshot_json TEXT,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft','delegated','queued','accepted','running','waiting_input','waiting_confirmation','succeeded','failed','cancelled','recovery_required','expired','blocked_budget','blocked_permission')),
          priority INTEGER NOT NULL DEFAULT 50,
          requires_confirmation INTEGER NOT NULL DEFAULT 0,
          confirmation_id TEXT,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 0,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          risk TEXT NOT NULL DEFAULT 'read',
          side_effect_started INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status, priority DESC, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_assigned ON agent_jobs(assigned_agent_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_parent ON agent_jobs(parent_job_id);
        CREATE INDEX IF NOT EXISTS idx_agent_jobs_store ON agent_jobs(store_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
          from_status TEXT,
          to_status TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT,
          evidence_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events(job_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS agent_job_results (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
          task_run_id TEXT,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          approved INTEGER NOT NULL DEFAULT 0,
          reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_job_results_job ON agent_job_results(job_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_memory_records (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
          scope TEXT NOT NULL CHECK(scope IN ('private','store','shared')),
          type TEXT NOT NULL CHECK(type IN ('semantic','procedural','episodic','shared')),
          title TEXT NOT NULL,
          file_path TEXT NOT NULL UNIQUE,
          content_hash TEXT NOT NULL,
          confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
          source_job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK(status IN ('pending-review','approved','stale','conflict','quarantined')),
          sensitivity TEXT NOT NULL CHECK(sensitivity IN ('low','internal','private')),
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory_records(agent_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory_records(scope, store_id, status);
        CREATE INDEX IF NOT EXISTS idx_agent_memory_job ON agent_memory_records(source_job_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
          memory_id UNINDEXED, title, content, keywords,
          tokenize='unicode61 remove_diacritics 1'
        );

        CREATE TABLE IF NOT EXISTS agent_feedback (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
          memory_id TEXT REFERENCES agent_memory_records(id) ON DELETE SET NULL,
          reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
          correction TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_usage (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          profile_id TEXT REFERENCES agent_model_profiles(id) ON DELETE SET NULL,
          job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_json TEXT,
          estimated INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          error_code TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_usage_agent ON agent_usage(agent_id, created_at DESC);

        INSERT OR IGNORE INTO app_settings(key, value_json, updated_at) VALUES
          ('agent.org.enabled', 'true', strftime('%s','now') * 1000),
          ('agent.jobs.enabled', 'true', strftime('%s','now') * 1000),
          ('agent.memory.enabled', 'true', strftime('%s','now') * 1000),
          ('agent.jobs.maxDepth', '12', strftime('%s','now') * 1000),
          ('agent.jobs.maxNodes', '50', strftime('%s','now') * 1000),
          ('agent.jobs.confirmationTtlMs', '600000', strftime('%s','now') * 1000),
          ('agent.jobs.leaseMs', '30000', strftime('%s','now') * 1000),
          ('agent.jobs.heartbeatMs', '10000', strftime('%s','now') * 1000),
          ('agent.memory.maxContextChars', '6000', strftime('%s','now') * 1000),
          ('agent.memory.maxResults', '50', strftime('%s','now') * 1000),
          ('agent.model.maxRetries', '1', strftime('%s','now') * 1000)
      `)
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS agent_memory_fts;
        DROP TABLE IF EXISTS agent_usage;
        DROP TABLE IF EXISTS agent_feedback;
        DROP TABLE IF EXISTS agent_memory_records;
        DROP TABLE IF EXISTS agent_job_results;
        DROP TABLE IF EXISTS agent_job_events;
        DROP TABLE IF EXISTS agent_jobs;
        DROP TABLE IF EXISTS agent_model_bindings;
        DROP TABLE IF EXISTS agent_model_profiles;
        DROP TABLE IF EXISTS agents;
      `)
    }
  },
  {
    version: 6,
    name: 'agent_job_confirmation_and_leases',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(agent_jobs)').all() as Array<{ name: string }>
      const names = new Set(columns.map(column => column.name))
      if (!names.has('confirmation_approved')) {
        db.exec('ALTER TABLE agent_jobs ADD COLUMN confirmation_approved INTEGER NOT NULL DEFAULT 0')
      }
      if (!names.has('confirmation_expires_at')) {
        db.exec('ALTER TABLE agent_jobs ADD COLUMN confirmation_expires_at INTEGER')
      }
      // Jobs that were already past the confirmation gate before v6 must not
      // be sent back to the gate after the migration.
      db.exec("UPDATE agent_jobs SET confirmation_approved=1 WHERE requires_confirmation=1 AND status NOT IN ('queued','accepted','waiting_confirmation')")
      db.exec("CREATE INDEX IF NOT EXISTS idx_agent_jobs_lease ON agent_jobs(status, lease_expires_at)")
      db.exec("CREATE INDEX IF NOT EXISTS idx_agent_jobs_confirmation ON agent_jobs(status, confirmation_expires_at)")
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_events (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES agent_memory_records(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('hit','adopted','rejected')),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memory_events_memory ON agent_memory_events(memory_id, event_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_memory_events_agent ON agent_memory_events(agent_id, event_type, created_at DESC);
      `)
    },
    // SQLite cannot drop columns on all supported desktop versions without a
    // table rebuild. The added columns are harmless on a down migration; the
    // indexes are removed so an explicit rollback remains bounded.
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_agent_jobs_lease; DROP INDEX IF EXISTS idx_agent_jobs_confirmation; DROP INDEX IF EXISTS idx_agent_memory_events_memory; DROP INDEX IF EXISTS idx_agent_memory_events_agent; DROP TABLE IF EXISTS agent_memory_events;')
    }
  },
  {
    version: 7,
    name: 'agent_model_pricing',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(agent_model_profiles)').all() as Array<{ name: string }>
      const names = new Set(columns.map(column => column.name))
      if (!names.has('pricing_json')) {
        db.exec('ALTER TABLE agent_model_profiles ADD COLUMN pricing_json TEXT')
      }
    },
    // SQLite cannot drop columns without a table rebuild. Leaving the column
    // in place on a downgrade keeps the cost-honest fallback: profiles read by
    // older versions simply have no price and report "未估算".
    down: () => {}
  },
  {
    version: 8,
    name: 'agent_skills_and_plugins',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          intent TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
          plugin_id TEXT,
          created_by_agent_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_name ON agent_skills(name);
        CREATE INDEX IF NOT EXISTS idx_agent_skills_status ON agent_skills(status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS agent_plugins (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          skill_ids_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','ai')),
          created_by_agent_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_plugins_name ON agent_plugins(name);
      `)
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS agent_plugins; DROP TABLE IF EXISTS agent_skills;')
    }
  }
]

/**
 * 获取当前数据库版本
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number } | undefined
    return row?.version || 0
  } catch {
    return 0
  }
}

/**
 * 执行迁移
 */
export function migrate(db: Database.Database, targetVersion?: number): void {
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
