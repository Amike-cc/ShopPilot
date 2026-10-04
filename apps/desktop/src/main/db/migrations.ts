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
  },
  {
    version: 9,
    name: 'agent_model_context_window',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(agent_model_profiles)').all() as Array<{ name: string }>
      const names = new Set(columns.map(column => column.name))
      if (!names.has('context_window_tokens')) {
        // NULL is intentional: the runtime infers a conservative window from
        // the provider/model and only uses this field as an advanced override.
        db.exec('ALTER TABLE agent_model_profiles ADD COLUMN context_window_tokens INTEGER')
      }
      // 6000 was the built-in fixed default.  Turn only that untouched
      // default into automatic mode; a user-chosen value is preserved as a
      // hard memory-context cap for compatibility.
      db.prepare("UPDATE app_settings SET value_json='0',updated_at=? WHERE key='agent.memory.maxContextChars' AND value_json='6000'").run(Date.now())
    },
    // SQLite column removal would require rebuilding the profile table. Older
    // app versions safely ignore the extra nullable column.
    down: () => {}
  },
  {
    version: 10,
    name: 'agent_memory_learning_governance',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(agent_memory_records)').all() as Array<{ name: string }>
      const names = new Set(columns.map(column => column.name))
      // These columns make the memory store self-improving without changing
      // the source file as truth.  They are counters and governance metadata;
      // an approved memory is still re-hashed before model injection.
      if (!names.has('origin')) db.exec("ALTER TABLE agent_memory_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','conversation','job','feedback','consolidated'))")
      if (!names.has('source_ref')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN source_ref TEXT')
      if (!names.has('access_count')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0')
      if (!names.has('adopt_count')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN adopt_count INTEGER NOT NULL DEFAULT 0')
      if (!names.has('reject_count')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN reject_count INTEGER NOT NULL DEFAULT 0')
      if (!names.has('last_hit_at')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN last_hit_at INTEGER')
      if (!names.has('last_feedback_at')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN last_feedback_at INTEGER')
      if (!names.has('archived_at')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN archived_at INTEGER')
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory_records(source_ref)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_lifecycle ON agent_memory_records(status, archived_at, expires_at, updated_at)')
      db.exec(`
        INSERT OR IGNORE INTO app_settings(key, value_json, updated_at) VALUES
          ('agent.memory.autoLearn', 'true', strftime('%s','now') * 1000),
          ('agent.memory.autoLearn.requireReview', 'true', strftime('%s','now') * 1000),
          ('agent.memory.retentionDays', '180', strftime('%s','now') * 1000),
          ('agent.memory.maxAutoCandidatesPerDay', '100', strftime('%s','now') * 1000)
      `)
    },
    // SQLite cannot remove added columns without rebuilding the table. Keeping
    // them on downgrade is safe: older binaries ignore the learning metadata.
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_agent_memory_source_ref; DROP INDEX IF EXISTS idx_agent_memory_lifecycle;')
    }
  },
  {
    version: 11,
    name: 'agent_memory_dedupe',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(agent_memory_records)').all() as Array<{ name: string }>
      const names = new Set(columns.map(column => column.name))
      // 近重复收敛所需：规范正文指纹 + 被重复观察的次数。
      // 历史行 dedupe_key 为 NULL，语义是「该条不参与去重」；新写入会带上，
      // 旧数据在「重建索引」时按正文补齐（rebuildMemoryIndex 已经读全部正文）。
      if (!names.has('dedupe_key')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN dedupe_key TEXT')
      if (!names.has('repeat_count')) db.exec('ALTER TABLE agent_memory_records ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0')
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_dedupe ON agent_memory_records(dedupe_key, agent_id, store_id, scope, type)')
    },
    // 去掉索引即可：多余的 NULL 列对旧版本无害。
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_agent_memory_dedupe;')
    }
  },
  {
    version: 12,
    name: 'unified_orders',
    up: (db) => {
      // 第三阶段只增加订单域；不改动现有任务/经营/商品表。
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          store_id TEXT NOT NULL,
          platform_order_id TEXT NOT NULL,
          status TEXT NOT NULL,
          platform_status TEXT,
          total_amount_minor INTEGER,
          paid_amount_minor INTEGER,
          refund_amount_minor INTEGER,
          currency TEXT NOT NULL DEFAULT 'CNY',
          buyer_json TEXT,
          order_created_at INTEGER,
          paid_at INTEGER,
          shipped_at INTEGER,
          completed_at INTEGER,
          platform_updated_at INTEGER,
          collected_at INTEGER NOT NULL,
          source_updated_at INTEGER,
          raw_snapshot_json TEXT,
          stored_at INTEGER NOT NULL,
          UNIQUE(platform, store_id, platform_order_id),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_orders_store_created ON orders(store_id, order_created_at DESC, stored_at DESC);
        CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status, order_created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_orders_platform_key ON orders(platform, store_id, platform_order_id);

        CREATE TABLE IF NOT EXISTS order_items (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          platform_item_id TEXT,
          platform_sku_id TEXT,
          title TEXT,
          sku_name TEXT,
          quantity INTEGER,
          unit_price_minor INTEGER,
          total_price_minor INTEGER,
          image_url TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      `)
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_order_items_order; DROP INDEX IF EXISTS idx_orders_platform_key; DROP INDEX IF EXISTS idx_orders_store_status; DROP INDEX IF EXISTS idx_orders_store_created;')
      db.exec('DROP TABLE IF EXISTS order_items; DROP TABLE IF EXISTS orders;')
    }
  },
  {
    version: 13,
    name: 'sales_metrics',
    up: (db) => {
      // 经营指标只保存聚合结果；订单详情表保持向后兼容但不参与本域写入。
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_metrics (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          store_id TEXT NOT NULL,
          period_type TEXT NOT NULL CHECK(period_type IN ('TODAY','YESTERDAY','LAST_7_DAYS','LAST_30_DAYS','CUSTOM')),
          period_start INTEGER NOT NULL,
          period_end INTEGER NOT NULL,
          order_count INTEGER,
          paid_order_count INTEGER,
          sales_quantity INTEGER,
          gross_sales_amount_minor INTEGER,
          paid_sales_amount_minor INTEGER,
          refund_amount_minor INTEGER,
          refund_order_count INTEGER,
          refund_quantity INTEGER,
          net_sales_amount_minor INTEGER,
          collected_at INTEGER NOT NULL,
          source_updated_at INTEGER,
          UNIQUE(platform, store_id, period_start, period_end),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sales_metrics_store_period ON sales_metrics(store_id, period_start DESC, period_end DESC);
        CREATE INDEX IF NOT EXISTS idx_sales_metrics_platform_period ON sales_metrics(platform, period_start DESC, period_end DESC);

        CREATE TABLE IF NOT EXISTS product_sales_metrics (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          store_id TEXT NOT NULL,
          platform_product_id TEXT,
          platform_sku_id TEXT,
          product_title TEXT,
          sku_name TEXT,
          image_url TEXT,
          sales_quantity INTEGER,
          order_count INTEGER,
          gross_sales_amount_minor INTEGER,
          paid_sales_amount_minor INTEGER,
          refund_quantity INTEGER,
          refund_amount_minor INTEGER,
          period_start INTEGER NOT NULL,
          period_end INTEGER NOT NULL,
          collected_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sales_metrics_business
          ON product_sales_metrics(platform, store_id, platform_product_id, platform_sku_id, period_start, period_end)
          WHERE platform_product_id IS NOT NULL OR platform_sku_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_product_sales_metrics_store_period ON product_sales_metrics(store_id, period_start DESC, period_end DESC);
        CREATE INDEX IF NOT EXISTS idx_product_sales_metrics_quantity ON product_sales_metrics(store_id, period_start DESC, sales_quantity DESC);
      `)
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_product_sales_metrics_quantity; DROP INDEX IF EXISTS idx_product_sales_metrics_store_period; DROP INDEX IF EXISTS idx_product_sales_metrics_business; DROP TABLE IF EXISTS product_sales_metrics; DROP INDEX IF EXISTS idx_sales_metrics_platform_period; DROP INDEX IF EXISTS idx_sales_metrics_store_period; DROP TABLE IF EXISTS sales_metrics;')
    }
  },
  {
    version: 14,
    name: 'store_snapshots_metric_index',
    up: (db) => {
      // overview:orders 按 metric 过滤 + 按店取最近一次快照：旧唯一索引 (store_id, metric,
      // captured_at) 首列不符，metric 过滤只能全表扫描且随历史无限增长；补 (metric, store_id)
      // 让过滤走索引。
      db.exec('CREATE INDEX IF NOT EXISTS idx_store_snapshots_metric ON store_snapshots (metric, store_id);')
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_store_snapshots_metric;')
    }
  },
  {
    version: 15,
    name: 'hot_query_indexes',
    up: (db) => {
      // 2026-09-28 审查用 EXPLAIN QUERY PLAN 实测出的四条缺索引，都在**只增不减**的表上：
      //   · model-governance 的日预算汇总 WHERE created_at BETWEEN … → agent_usage 纯全表扫描
      //     （现有索引首列是 agent_id，帮不上）；
      //   · audit:query 按 action / requestId 过滤 → 两条都退化成全索引扫描（审计是合规入口）；
      //   · overview 的"近 7 天运行统计" WHERE started_at > ? → task_runs 的 started_at 无索引。
      // 顺序上必须与保留策略一起上：将来第一次大批量 DELETE 若没有这些索引，
      // 删除事务会长时间持锁，反而把"清理"变成一次卡顿事故。
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_request ON audit_logs (request_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_task_runs_started_at ON task_runs (started_at DESC);
      `)
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_agent_usage_created;
        DROP INDEX IF EXISTS idx_audit_logs_action;
        DROP INDEX IF EXISTS idx_audit_logs_request;
        DROP INDEX IF EXISTS idx_task_runs_started_at;
      `)
    }
  },
  {
    version: 16,
    name: 'sales_metrics_collection_runtime',
    up: (db) => {
      // 自动经营数据采集的计划、运行记录和脱敏证据。经营指标本身仍由
      // sales_metrics 保存；这些表只描述“何时采、采了什么、为什么失败”。
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_collection_plans (
          store_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          interval_ms INTEGER NOT NULL DEFAULT 600000 CHECK(interval_ms >= 60000),
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          next_run_at INTEGER,
          last_started_at INTEGER,
          last_success_at INTEGER,
          last_status TEXT,
          last_reason_code TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          backoff_until INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sales_collection_plans_due ON sales_collection_plans(enabled, next_run_at);

        CREATE TABLE IF NOT EXISTS sales_collection_runs (
          run_id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          planned_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          status TEXT NOT NULL,
          reason_code TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          adapter_version TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sales_collection_runs_store_time ON sales_collection_runs(store_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sales_collection_runs_status ON sales_collection_runs(status, created_at DESC);

        CREATE TABLE IF NOT EXISTS sales_metrics_raw (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          store_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          field_name TEXT NOT NULL,
          value_type TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_url_hash TEXT,
          captured_at INTEGER NOT NULL,
          evidence_path TEXT,
          parser_version TEXT,
          confidence REAL,
          FOREIGN KEY (run_id) REFERENCES sales_collection_runs(run_id) ON DELETE CASCADE,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sales_metrics_raw_run ON sales_metrics_raw(run_id, captured_at DESC);
      `)
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_sales_metrics_raw_run; DROP TABLE IF EXISTS sales_metrics_raw; DROP INDEX IF EXISTS idx_sales_collection_runs_status; DROP INDEX IF EXISTS idx_sales_collection_runs_store_time; DROP TABLE IF EXISTS sales_collection_runs; DROP INDEX IF EXISTS idx_sales_collection_plans_due; DROP TABLE IF EXISTS sales_collection_plans;')
    }
  },
  {
    version: 17,
    name: 'sales_metrics_traceability',
    up: (db) => {
      // 来源可追溯（开发文档 §5/§12）：统一指标必须能回答"这行数据哪来的、哪版解析器写的、
      // 口径是哪一版、这条是真实 0 还是部分成功"。没有这几列时，前端只能猜——而"猜"正是
      // 把真实 0 显示成"未采集"的根源。
      const metricColumns = new Set((db.prepare('PRAGMA table_info(sales_metrics)').all() as Array<{ name: string }>).map(column => column.name))
      if (!metricColumns.has('source_type')) db.exec("ALTER TABLE sales_metrics ADD COLUMN source_type TEXT NOT NULL DEFAULT 'NONE'")
      if (!metricColumns.has('adapter_version')) db.exec('ALTER TABLE sales_metrics ADD COLUMN adapter_version TEXT')
      if (!metricColumns.has('metric_definition_version')) db.exec("ALTER TABLE sales_metrics ADD COLUMN metric_definition_version TEXT NOT NULL DEFAULT 'sales-metrics-1'")
      if (!metricColumns.has('data_status')) db.exec("ALTER TABLE sales_metrics ADD COLUMN data_status TEXT NOT NULL DEFAULT 'UNKNOWN'")
      if (!metricColumns.has('run_id')) db.exec('ALTER TABLE sales_metrics ADD COLUMN run_id TEXT')

      // 运行台账补上"这一拍到底写了什么"：safe_message 面向用户，metrics_json 只存**聚合后**
      // 的九个指标（不含订单正文/买家信息），用于 24 小时趋势与"数据不倒退"的比对。
      const runColumns = new Set((db.prepare('PRAGMA table_info(sales_collection_runs)').all() as Array<{ name: string }>).map(column => column.name))
      if (!runColumns.has('safe_message')) db.exec('ALTER TABLE sales_collection_runs ADD COLUMN safe_message TEXT')
      if (!runColumns.has('source_type')) db.exec('ALTER TABLE sales_collection_runs ADD COLUMN source_type TEXT')
      if (!runColumns.has('inserted')) db.exec('ALTER TABLE sales_collection_runs ADD COLUMN inserted INTEGER NOT NULL DEFAULT 0')
      if (!runColumns.has('updated')) db.exec('ALTER TABLE sales_collection_runs ADD COLUMN updated INTEGER NOT NULL DEFAULT 0')
      if (!runColumns.has('metrics_json')) db.exec('ALTER TABLE sales_collection_runs ADD COLUMN metrics_json TEXT')
      if (!runColumns.has('data_status')) db.exec("ALTER TABLE sales_collection_runs ADD COLUMN data_status TEXT NOT NULL DEFAULT 'UNKNOWN'")

      // 计划也要能回答"上次为什么停下来"：只存 reasonCode 时，前端只能显示一串大写英文码。
      const planColumns = new Set((db.prepare('PRAGMA table_info(sales_collection_plans)').all() as Array<{ name: string }>).map(column => column.name))
      if (!planColumns.has('last_safe_message')) db.exec('ALTER TABLE sales_collection_plans ADD COLUMN last_safe_message TEXT')

      // 脱敏证据摘要：evidence_digest 让"同一份证据被重复引用"可判别，且它本身不可逆。
      const rawColumns = new Set((db.prepare('PRAGMA table_info(sales_metrics_raw)').all() as Array<{ name: string }>).map(column => column.name))
      if (!rawColumns.has('evidence_digest')) db.exec('ALTER TABLE sales_metrics_raw ADD COLUMN evidence_digest TEXT')

      // 保留策略要按时间删（§28）：没有这两条索引，第一次大批量清理会长时间持锁。
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sales_collection_runs_created ON sales_collection_runs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sales_metrics_raw_captured ON sales_metrics_raw(captured_at DESC);
      `)
    },
    // SQLite 不能删列；旧版本会忽略多出来的可空列与新索引，降级是安全的。
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_sales_collection_runs_created; DROP INDEX IF EXISTS idx_sales_metrics_raw_captured;')
    }
  },
  {
    version: 18,
    name: 'sales_metrics_ad_spend',
    up: (db) => {
      // 投放花费（§12 六项概览指标之一）。加列而不是塞进别的字段：它是**平台自己的口径**
      // （抖店「投放消耗」、拼多多「推广花费」），没有来源的平台必须留 null；
      // 和成交额混在一起，事后就答不出"这笔钱是谁花的、按谁的规则统计的"。
      const metricColumns = new Set((db.prepare('PRAGMA table_info(sales_metrics)').all() as Array<{ name: string }>).map(column => column.name))
      if (!metricColumns.has('ad_spend_minor')) db.exec('ALTER TABLE sales_metrics ADD COLUMN ad_spend_minor INTEGER')
    },
    // SQLite 不能删列；旧版本会忽略多出来的可空列，降级是安全的。
    down: () => { /* 无可回滚动作 */ }
  },
  {
    version: 19,
    name: 'product_catalog',
    up: (db) => {
      // 商品域建表（商品管理方案 §4；真机勘察记录见 docs/product-profiles.md）。
      //
      // 三条设计纪律（都能在迁移里看出来）：
      //   1) **平台原值与本地编辑值分开存** —— 平台侧同步回来的真相写进 *_links.platform_*，
      //      本地商品写进 products。冲突时不覆盖（与 store-license 的 decideLicenseWrite 同哲学：
      //      宁可少填，不可填错）。
      //   2) **平台商品与本地商品不自动合并** —— links.product_id 可空，空 = 平台上发现、本地还没归属，
      //      等用户在界面上确认归并（自动合并错了是两个商品被搅一起，比不合并更糟）。
      //   3) **SKU 映射单独一张表** —— 平台 SKU 会增删改名（"红/L" → "红色/L码"），
      //      混在商品行的 JSON 里会让整条映射作废；分开存后商品映射稳定、SKU 逐条增删。
      db.exec(`
        ------------------------------------------------------------------ 本地商品
        CREATE TABLE IF NOT EXISTS products (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          subtitle        TEXT,
          description     TEXT,
          brand           TEXT,
          local_category  TEXT,
          tags_json       TEXT,
          cover_media_id  TEXT,
          status          TEXT NOT NULL DEFAULT 'draft'
                          CHECK(status IN ('draft','ready','published','archived')),
          -- 草稿指纹：判断"是否需要重发"，也是发布幂等键的组成部分
          draft_hash      TEXT NOT NULL,
          -- 从哪个平台商品"另存为本地商品"来的（可空）
          source_link_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          -- 软删：硬删会把发布台账（审计材料）级联掉
          deleted_at      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_products_status  ON products(status, updated_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_products_title   ON products(title) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at DESC);

        CREATE TABLE IF NOT EXISTS product_variants (
          id                 TEXT PRIMARY KEY,
          product_id         TEXT NOT NULL,
          spec_json          TEXT,
          sku_code           TEXT,
          barcode            TEXT,
          price_minor        INTEGER,
          market_price_minor INTEGER,
          stock              INTEGER,
          weight_gram        INTEGER,
          image_media_id     TEXT,
          sort_order         INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL,
          -- 同一商品内规格组合不可重复（"红/L" 只能有一行）
          UNIQUE(product_id, spec_json),
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, sort_order);

        CREATE TABLE IF NOT EXISTS product_media (
          id           TEXT PRIMARY KEY,
          product_id   TEXT,
          variant_id   TEXT,
          role         TEXT NOT NULL DEFAULT 'gallery'
                       CHECK(role IN ('cover','gallery','detail','sku')),
          origin       TEXT NOT NULL DEFAULT 'platform'
                       CHECK(origin IN ('platform','local','imported')),
          remote_url   TEXT,
          -- userData/product-media/<sha256前2位>/<sha256>.<ext>
          local_path   TEXT,
          sha256       TEXT,
          bytes        INTEGER,
          width        INTEGER,
          height       INTEGER,
          mime         TEXT,
          state        TEXT NOT NULL DEFAULT 'pending'
                       CHECK(state IN ('pending','localized','failed','blocked','missing')),
          -- 'blocked' = 我们主动拒绝（私网地址/格式不允许）；'failed' = 下载失败（网络/防盗链）。话术不同
          fail_reason  TEXT,
          sort_order   INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        -- 同图只存一份文件：10 个商品共用一张主图 → 1 个文件、10 行记录
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha     ON product_media(sha256) WHERE sha256 IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_media_product        ON product_media(product_id, role, sort_order);
        CREATE INDEX IF NOT EXISTS idx_media_state          ON product_media(state) WHERE state != 'localized';

        -------------------------------------------------------- 平台映射（同步幂等的关键）
        CREATE TABLE IF NOT EXISTS product_platform_links (
          id                     TEXT PRIMARY KEY,
          -- NULL = 平台有、本地未归并
          product_id             TEXT,
          platform               TEXT NOT NULL,
          store_id               TEXT NOT NULL,
          platform_product_id    TEXT NOT NULL,
          platform_title         TEXT,
          platform_subtitle      TEXT,
          platform_status        TEXT
                                 CHECK(platform_status IN ('on_sale','off_shelf','auditing','violation','missing','unknown')),
          platform_price_minor   INTEGER,
          platform_stock         INTEGER,
          platform_category_path TEXT,
          platform_image_count   INTEGER,
          platform_updated_at    INTEGER,
          first_seen_at          INTEGER NOT NULL,
          collected_at           INTEGER NOT NULL,
          -- 保底：整行原始表数据（参与保留策略）
          raw_snapshot_json      TEXT,
          UNIQUE(platform, store_id, platform_product_id),
          -- 同一店铺里一个本地商品只允许一个平台商品（防"发重了"被当成两条合法记录）。
          -- SQLite 对 NULL 不去重 → 正好实现"未归并的可以很多行、已归并的每店只能一行"
          UNIQUE(store_id, product_id),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ppl_product ON product_platform_links(product_id);
        CREATE INDEX IF NOT EXISTS idx_ppl_store   ON product_platform_links(store_id, platform_updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ppl_orphan  ON product_platform_links(store_id) WHERE product_id IS NULL;

        CREATE TABLE IF NOT EXISTS product_sku_links (
          id                  TEXT PRIMARY KEY,
          link_id             TEXT NOT NULL,
          -- NULL = 平台有这个 SKU，本地还没对上
          variant_id          TEXT,
          platform_sku_id     TEXT NOT NULL,
          platform_spec_json  TEXT,
          platform_price_minor INTEGER,
          platform_stock      INTEGER,
          -- missing = 平台侧没了：**不删行**，下次出现可自动复活
          state               TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','missing')),
          collected_at        INTEGER NOT NULL,
          UNIQUE(link_id, platform_sku_id),
          FOREIGN KEY (link_id) REFERENCES product_platform_links(id) ON DELETE CASCADE,
          FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sku_links_link    ON product_sku_links(link_id, state);
        CREATE INDEX IF NOT EXISTS idx_sku_links_variant ON product_sku_links(variant_id) WHERE variant_id IS NOT NULL;

        ------------------------------------------- 平台字段默认值（半自动"越用越自动"的来源）
        CREATE TABLE IF NOT EXISTS product_platform_defaults (
          id           TEXT PRIMARY KEY,
          -- NULL = 平台级默认（不区分商品）
          product_id   TEXT,
          platform     TEXT NOT NULL,
          scope        TEXT NOT NULL CHECK(scope IN ('product','platform_default')),
          field_key    TEXT NOT NULL,
          field_value  TEXT,
          -- human_readback = 从人工那一遍回读来的；user_edit = 用户自己在编辑页设的。界面话术不同
          source       TEXT NOT NULL CHECK(source IN ('human_readback','user_edit')),
          confirmed_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_defaults_key
          ON product_platform_defaults(platform, COALESCE(product_id,''), field_key);

        ------------------------------------------------------------------ 台账
        CREATE TABLE IF NOT EXISTS product_sync_runs (
          id             TEXT PRIMARY KEY,
          store_id       TEXT NOT NULL,
          trigger        TEXT NOT NULL CHECK(trigger IN ('manual','schedule')),
          status         TEXT NOT NULL,
          reason_code    TEXT,
          fetched_count  INTEGER NOT NULL DEFAULT 0,
          inserted_count INTEGER NOT NULL DEFAULT 0,
          updated_count  INTEGER NOT NULL DEFAULT 0,
          missing_count  INTEGER NOT NULL DEFAULT 0,
          skipped_count  INTEGER NOT NULL DEFAULT 0,
          has_more       INTEGER NOT NULL DEFAULT 0,
          page_count     INTEGER NOT NULL DEFAULT 0,
          duration_ms    INTEGER,
          started_at     INTEGER NOT NULL,
          finished_at    INTEGER,
          safe_message   TEXT,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sync_runs_store ON product_sync_runs(store_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS product_publish_jobs (
          id           TEXT PRIMARY KEY,
          product_id   TEXT NOT NULL,
          draft_hash   TEXT NOT NULL,
          mode         TEXT NOT NULL DEFAULT 'fill' CHECK(mode IN ('fill')),
          status       TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          finished_at  INTEGER
        );

        CREATE TABLE IF NOT EXISTS product_publish_items (
          id                  TEXT PRIMARY KEY,
          job_id              TEXT NOT NULL,
          store_id            TEXT NOT NULL,
          -- 本次实际用了哪一档（L1 填充 / L2 引导 / L3 接力）
          tier                TEXT NOT NULL CHECK(tier IN ('L1','L2','L3')),
          status              TEXT NOT NULL,
          filled_json         TEXT,
          manual_field_count  INTEGER NOT NULL DEFAULT 0,
          platform_product_id TEXT,
          reason_code         TEXT,
          safe_message        TEXT,
          evidence_json       TEXT,
          task_run_id         TEXT,
          updated_at          INTEGER NOT NULL,
          UNIQUE(job_id, store_id),
          FOREIGN KEY (job_id) REFERENCES product_publish_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_publish_items_pending ON product_publish_items(status)
          WHERE status IN ('awaiting_human','needs_review');
        CREATE INDEX IF NOT EXISTS idx_publish_items_job ON product_publish_items(job_id);
      `)
    },
    // 只删表，**不删 userData/product-media 里的图片文件** —— 迁移的回滚不该动用户磁盘上的东西，
    // 孤儿图片交给保留策略（services/retention.ts）按 90 天清理。
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_publish_items_job;
        DROP INDEX IF EXISTS idx_publish_items_pending;
        DROP TABLE IF EXISTS product_publish_items;
        DROP TABLE IF EXISTS product_publish_jobs;
        DROP INDEX IF EXISTS idx_sync_runs_store;
        DROP TABLE IF EXISTS product_sync_runs;
        DROP INDEX IF EXISTS idx_defaults_key;
        DROP TABLE IF EXISTS product_platform_defaults;
        DROP INDEX IF EXISTS idx_sku_links_variant;
        DROP INDEX IF EXISTS idx_sku_links_link;
        DROP TABLE IF EXISTS product_sku_links;
        DROP INDEX IF EXISTS idx_ppl_orphan;
        DROP INDEX IF EXISTS idx_ppl_store;
        DROP INDEX IF EXISTS idx_ppl_product;
        DROP TABLE IF EXISTS product_platform_links;
        DROP INDEX IF EXISTS idx_media_state;
        DROP INDEX IF EXISTS idx_media_product;
        DROP INDEX IF EXISTS idx_media_sha;
        DROP TABLE IF EXISTS product_media;
        DROP INDEX IF EXISTS idx_variants_product;
        DROP TABLE IF EXISTS product_variants;
        DROP INDEX IF EXISTS idx_products_updated;
        DROP INDEX IF EXISTS idx_products_title;
        DROP INDEX IF EXISTS idx_products_status;
        DROP TABLE IF EXISTS products;
      `)
    }
  },
  {
    version: 20,
    name: 'product_link_image_urls',
    up: (db) => {
      // 商品图片本地化需要**图片地址**，而 v19 只存了张数（platform_image_count）。
      // 采集时其实拿到了 URL（列表页每行一张缩略图），没地方放就等于丢掉了 —— 于是"图片本地化"
      // 这一整条链路没有输入。补一列存 URL 数组（JSON）。
      //
      // 加列而不是新表：它是**平台商品行的一个属性**，与那一行同生共死，没有独立生命周期。
      // SQLite 不能删列；旧版本会忽略多出来的可空列，降级安全。
      const columns = new Set(
        (db.prepare('PRAGMA table_info(product_platform_links)').all() as Array<{ name: string }>).map(column => column.name)
      )
      if (!columns.has('platform_image_urls_json')) {
        db.exec('ALTER TABLE product_platform_links ADD COLUMN platform_image_urls_json TEXT')
      }
    },
    down: () => { /* SQLite 不能删列；旧版本忽略该列即可 */ }
  },
  {
    version: 21,
    name: 'product_platform_requirements',
    up: (db) => {
      // 平台**必填字段清单**（方案 §7.5 第 3 类回读）：把"发布页必填但本地没有"的字段记下来，
      // 下次发布前在本地补全清单里提示。
      //
      // 为什么单独一张表而不是塞进 defaults：它是**平台的事实**（这个平台要求填这些），
      // 不是"某次填了什么值"；混在一起会让"默认值"这个概念变脏。
      // 主键用 (platform, field_key)：同一平台同一字段只留一条，重复观察只更新 observed_at。
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_platform_requirements (
          id          TEXT PRIMARY KEY,
          platform    TEXT NOT NULL,
          field_key   TEXT NOT NULL,
          label       TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          UNIQUE(platform, field_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ppr_platform ON product_platform_requirements(platform);
      `)
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_ppr_platform;
        DROP TABLE IF EXISTS product_platform_requirements;
      `)
    }
  },
  {
    version: 22,
    name: 'product_publish_batch',
    up: (db) => {
      // 批量发布（方案 §7.8）：一次批量 = 多个 job（每个商品一个 job，job 里每店一个 item）。
      // 加一列把同一次批量的 job 归到一起，进度按批次汇总。
      //
      // 为什么不是"一个 job 装下所有商品"：`product_publish_items` 上有 `UNIQUE(job_id, store_id)`
      // 与 `FOREIGN KEY(store_id)`，job 的语义本来就是"**一个商品**发到一批店铺"。
      // 硬塞多个商品会把这个约束和语义一起弄坏；用 batch_id 归组更干净，也不动既有约束。
      const columns = new Set(
        (db.prepare('PRAGMA table_info(product_publish_jobs)').all() as Array<{ name: string }>).map(column => column.name)
      )
      if (!columns.has('batch_id')) {
        db.exec('ALTER TABLE product_publish_jobs ADD COLUMN batch_id TEXT')
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_ppj_batch ON product_publish_jobs(batch_id)')
    },
    down: (db) => { db.exec('DROP INDEX IF EXISTS idx_ppj_batch') }
  },
  {
    version: 23,
    name: 'product_media_attempts',
    up: (db) => {
      // 图片本地化的**重试计数**：队列靠它判断"这张还值不值得再试"。
      // 没有这一列时只能看 state（failed），于是"网络抖一下失败"和"试了十次都不行"长得一模一样，
      // 队列会一直重试同一张图（拖慢队列、刷满日志，还让人误以为多试几次就好）。
      const columns = new Set(
        (db.prepare('PRAGMA table_info(product_media)').all() as Array<{ name: string }>).map(column => column.name)
      )
      if (!columns.has('attempts')) {
        db.exec('ALTER TABLE product_media ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_pmedia_state ON product_media(state)')
    },
    down: (db) => { db.exec('DROP INDEX IF EXISTS idx_pmedia_state') }
  },
  {
    version: 24,
    name: 'media_sha_not_globally_unique',
    up: (db) => {
      // ⚠️ 修一个设计错误（2026-09-30 实测抓到）：`product_media.sha256` 原来是**全局唯一**的，
      // 但**同一张图合法地出现在多个商品上**（同款商品的图被多个本地商品引用，
      // 平台侧也确实存在同一张图挂多个商品的情况）。
      // 结果：给第二个商品写同一张图时直接 `UNIQUE constraint failed: product_media.sha256`，
      // 整个商品的本地化全部失败（实测：队列跑一个商品，一张都没成功）。
      //
      // "同图只存一份**文件**"说的是**文件**（路径按 sha256 生成，天然去重），
      // 不是"媒体行只能有一条"。所以这里把唯一约束去掉，改成普通索引（仍然查得快），
      // 唯一性交给 `(product_id, sha256)` —— 同一个商品内不重复引用同一张图。
      db.exec('DROP INDEX IF EXISTS idx_media_sha')
      db.exec('CREATE INDEX IF NOT EXISTS idx_media_sha_lookup ON product_media(sha256) WHERE sha256 IS NOT NULL')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_media_product_sha ON product_media(product_id, sha256) WHERE sha256 IS NOT NULL')
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_media_product_sha')
      db.exec('DROP INDEX IF EXISTS idx_media_sha_lookup')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha ON product_media(sha256) WHERE sha256 IS NOT NULL')
    }
  }
  ,{
    version: 25,
    name: 'commerce_writeback_proposals',
    up: (db) => {
      // 库存/价格/SKU 写回先落人工确认提案，平台适配器完成实测前不得直接写平台。
      // 幂等键由 storeId + platform + productId + skuId + inputHash 组成，重启后仍可识别重复请求。
      db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_writeback_proposals (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL CHECK(domain IN ('inventory','sku')),
          store_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          product_id TEXT NOT NULL,
          sku_id TEXT NOT NULL DEFAULT '',
          input_hash TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('WAITING_CONFIRMATION','NOT_VERIFIED','SUCCEEDED','FAILED')),
          confirmation_id TEXT,
          before_after_json TEXT NOT NULL,
          side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK(side_effect_started IN (0,1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_commerce_writeback_store ON commerce_writeback_proposals(store_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commerce_writeback_domain ON commerce_writeback_proposals(domain, status, updated_at DESC);
      `)
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_commerce_writeback_domain; DROP INDEX IF EXISTS idx_commerce_writeback_store; DROP TABLE IF EXISTS commerce_writeback_proposals;')
    }
  },
  {
    version: 26,
    name: 'order_operations',
    up: (db) => {
      // 履约/售后只保存脱敏状态摘要；平台写回仍由真实适配器和人工确认门禁负责。
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_fulfillments (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL UNIQUE,
          logistics_status TEXT NOT NULL CHECK(logistics_status IN ('NOT_SHIPPED','READY','SHIPPED','DELIVERED','EXCEPTION','UNKNOWN')),
          carrier TEXT,
          tracking_no_masked TEXT,
          platform_status TEXT,
          source TEXT NOT NULL CHECK(source IN ('PLATFORM_READBACK','LOCAL_LEDGER','UNKNOWN')),
          collected_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_order_fulfillments_status ON order_fulfillments(order_id, logistics_status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS after_sale_cases (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          platform_case_id TEXT,
          case_status TEXT NOT NULL CHECK(case_status IN ('APPLIED','REVIEWING','APPROVED','REJECTED','RETURNING','REFUNDED','CLOSED','UNKNOWN')),
          refund_status TEXT NOT NULL CHECK(refund_status IN ('NONE','REQUESTED','PROCESSING','SUCCEEDED','FAILED','UNKNOWN')),
          amount_minor INTEGER,
          platform_status TEXT,
          source TEXT NOT NULL CHECK(source IN ('PLATFORM_READBACK','LOCAL_LEDGER','UNKNOWN')),
          collected_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          UNIQUE(order_id, platform_case_id)
        );
        CREATE INDEX IF NOT EXISTS idx_after_sale_cases_order ON after_sale_cases(order_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_after_sale_cases_status ON after_sale_cases(case_status, refund_status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS order_action_proposals (
          id TEXT PRIMARY KEY,
          action_domain TEXT NOT NULL CHECK(action_domain IN ('FULFILLMENT','REFUND')),
          store_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('WAITING_CONFIRMATION','NOT_VERIFIED','SUCCEEDED','FAILED','RECOVERY_REQUIRED')),
          confirmation_id TEXT,
          before_after_json TEXT NOT NULL,
          side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK(side_effect_started IN (0,1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_order_action_proposals_store ON order_action_proposals(store_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_order_action_proposals_domain ON order_action_proposals(action_domain, status, updated_at DESC);
      `)
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_order_action_proposals_domain; DROP INDEX IF EXISTS idx_order_action_proposals_store; DROP TABLE IF EXISTS order_action_proposals; DROP INDEX IF EXISTS idx_after_sale_cases_status; DROP INDEX IF EXISTS idx_after_sale_cases_order; DROP TABLE IF EXISTS after_sale_cases; DROP INDEX IF EXISTS idx_order_fulfillments_status; DROP TABLE IF EXISTS order_fulfillments;')
    }
  },
  {
    version: 27,
    name: 'commerce_content_growth_workspace',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_content_drafts (
          id TEXT PRIMARY KEY,
          store_id TEXT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('DRAFT','REVIEWED','PUBLISH_PROPOSED','PUBLISHED','REJECTED')),
          input_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_content_draft_hash ON commerce_content_drafts(input_hash);
        CREATE TABLE IF NOT EXISTS commerce_growth_plans (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          domain TEXT NOT NULL CHECK(domain IN ('CAMPAIGN','COUPON','AD')),
          name TEXT NOT NULL,
          budget_minor INTEGER,
          status TEXT NOT NULL CHECK(status IN ('PLANNED','WAITING_CONFIRMATION','NOT_VERIFIED','SUCCEEDED','FAILED')),
          input_hash TEXT NOT NULL UNIQUE,
          confirmation_id TEXT,
          platform_task_id TEXT,
          readback_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_growth_plans_store ON commerce_growth_plans(store_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS commerce_customer_drafts (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('DRAFT','WAITING_CONFIRMATION','SENT','NOT_VERIFIED')),
          input_hash TEXT NOT NULL UNIQUE,
          confirmation_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_customer_drafts_store ON commerce_customer_drafts(store_id, updated_at DESC);
      `)
    },
    down: (db) => db.exec('DROP INDEX IF EXISTS idx_customer_drafts_store; DROP TABLE IF EXISTS commerce_customer_drafts; DROP INDEX IF EXISTS idx_growth_plans_store; DROP TABLE IF EXISTS commerce_growth_plans; DROP INDEX IF EXISTS idx_content_draft_hash; DROP TABLE IF EXISTS commerce_content_drafts;')
  },
  {
    version: 28,
    name: 'commerce_agent_action_ledger',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_agent_action_ledger (
          id TEXT PRIMARY KEY,
          action_type TEXT NOT NULL,
          store_id TEXT,
          input_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_confirmation','succeeded','failed','recovery_required','blocked_budget','blocked_permission','not_verified','partial')),
          confirmation_id TEXT,
          side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK(side_effect_started IN (0,1)),
          evidence_json TEXT,
          summary_json TEXT,
          recovery_advice TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(action_type, store_id, input_hash),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commerce_agent_ledger_store ON commerce_agent_action_ledger(store_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commerce_agent_ledger_status ON commerce_agent_action_ledger(status, updated_at DESC);
      `)
    },
    down: (db) => db.exec('DROP INDEX IF EXISTS idx_commerce_agent_ledger_status; DROP INDEX IF EXISTS idx_commerce_agent_ledger_store; DROP TABLE IF EXISTS commerce_agent_action_ledger;')
  }
  ,{
    version: 29,
    name: 'link_draft_hash',
    up: (db) => {
      // 修 §12.11 那个挡死主链路的 bug（2026-10-02 查明）：
      // `precheckPublish` 的文案说"本地草稿与上次完全一致才拒绝、改了内容就允许再发"，
      // 但代码只判断"这家店有没有链接"，而"上次的草稿指纹"**根本没落库**，比不了。
      // 结果：商品在某家店发过一次之后**永远发不出去**，且界面骗用户说改了就能发。
      // 这里补上这一列：发布成功时写入当时的草稿 hash，预检据此判断是不是真的"白跑一趟"。
      // nullable：老数据没有这个值 → 预检按"放行"处理（不能因为缺数据就永久禁止发布）。
      try { db.exec('ALTER TABLE product_platform_links ADD COLUMN draft_hash TEXT') } catch { /* 列已存在 */ }
    },
    down: (db) => {
      try { db.exec('ALTER TABLE product_platform_links DROP COLUMN draft_hash') } catch { /* ignore */ }
    }
  }
  ,{
    version: 30,
    name: 'invite_history',
    up: (db) => {
      /**
       * 邀约台账（用户要求：**7 天内邀过的达人不再重复邀约**）。
       *
       * 为什么必须自己记账：2026-10-04 真机实测，微信带货者广场的**列表行上没有任何"已邀约"标记**，
       * 详情链接是 `javascript:void(0)`、也拿不到 finderUsername —— 想"在点「详情」之前就跳过"
       * 只能靠我们自己的历史记录。平台的"7 天内不可再次邀请"是**兜底**（点进详情页会看到按钮禁用，
       * 引擎按 TASK_DAREN_ALREADY_INVITED 跳过），但那要先花一次详情页访问。
       *
       * 记的是"列表里显示的那个昵称"（nickname）——因为跳过时要拿它跟列表行文本比对；
       * finder_username 从详情页地址里取，作为稳定标识留档（昵称可能改）。
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS invite_history (
          id TEXT PRIMARY KEY,
          store_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          nickname TEXT NOT NULL,
          finder_username TEXT,
          task_id TEXT,
          run_id TEXT,
          invited_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_invite_history_store_time ON invite_history(store_id, invited_at DESC);
        CREATE INDEX IF NOT EXISTS idx_invite_history_nickname ON invite_history(store_id, nickname);
      `)
    },
    down: (db) => db.exec('DROP INDEX IF EXISTS idx_invite_history_nickname; DROP INDEX IF EXISTS idx_invite_history_store_time; DROP TABLE IF EXISTS invite_history;')
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
