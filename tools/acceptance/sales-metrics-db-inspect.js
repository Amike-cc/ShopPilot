/**
 * 经营数据自动采集台账检查（只读）。
 *
 * 用法：
 *   node tools/acceptance/sales-metrics-db-inspect.js [dbPath]
 *
 * 默认读 %APPDATA%\shopilot\shopilot.db；只 SELECT，不写库、不改档。
 * 输出用于 Windows 桌面验收的「界面与数据库一致」「没有残留 RUNNING」两项。
 */
const Database = require('better-sqlite3')
const { join } = require('path')
const { existsSync } = require('fs')

const explicit = process.argv.slice(2).find(arg => !arg.startsWith('-'))
const dbPath = explicit || join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')

function safe(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params)
  } catch (error) {
    return [{ error: String(error.message || error) }]
  }
}

if (!existsSync(dbPath)) {
  console.error('DB_NOT_FOUND ' + dbPath)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout = 5000')

const out = {
  dbPath,
  schemaVersion: safe(db, 'SELECT MAX(version) AS version FROM schema_migrations')[0],
  stores: safe(db, 'SELECT id, name, platform, status FROM stores ORDER BY platform, name'),
  plans: safe(db, 'SELECT store_id, platform, enabled, interval_ms, timezone, next_run_at, last_started_at, last_success_at, last_status, last_reason_code, consecutive_failures, backoff_until FROM sales_collection_plans ORDER BY platform, store_id'),
  runningRuns: safe(db, "SELECT run_id, store_id, platform, status, started_at FROM sales_collection_runs WHERE status = 'RUNNING'"),
  runStatusCounts: safe(db, 'SELECT status, COUNT(*) AS count FROM sales_collection_runs GROUP BY status ORDER BY count DESC'),
  recentRuns: safe(db, 'SELECT run_id, store_id, platform, status, reason_code, planned_at, started_at, finished_at, duration_ms, adapter_version FROM sales_collection_runs ORDER BY created_at DESC LIMIT 30'),
  metricsByStore: safe(db, `SELECT store_id, platform, period_type, period_start, period_end, order_count, paid_order_count, sales_quantity,
      gross_sales_amount_minor, paid_sales_amount_minor, refund_amount_minor, refund_order_count, refund_quantity, net_sales_amount_minor,
      collected_at, source_updated_at FROM sales_metrics ORDER BY collected_at DESC LIMIT 30`),
  rawEvidence: safe(db, 'SELECT COUNT(*) AS count FROM sales_metrics_raw')[0],
  rawEvidenceSample: safe(db, 'SELECT run_id, store_id, platform, field_name, value_type, source_type, source_url_hash, parser_version, confidence FROM sales_metrics_raw ORDER BY captured_at DESC LIMIT 20'),
  // 幂等核对：同一个 (平台, 店铺, 周期) 只能有一行。>1 就说明"重复采集幂等"在真实运行里没成立。
  duplicateMetrics: safe(db, `SELECT platform, store_id, period_type, period_start, period_end, COUNT(*) AS rows
      FROM sales_metrics GROUP BY platform, store_id, period_start, period_end HAVING COUNT(*) > 1`),
  metricRowCount: safe(db, 'SELECT COUNT(*) AS count FROM sales_metrics')[0],
  metricsPerStore: safe(db, `SELECT store_id, platform, period_type, period_start, period_end, COUNT(*) AS rows,
      SUM(CASE WHEN collected_at IS NOT NULL THEN 1 ELSE 0 END) AS with_collected_at
      FROM sales_metrics GROUP BY store_id, platform, period_type, period_start, period_end ORDER BY platform`)
}

console.log(JSON.stringify(out, null, 2))
db.close()
// 用 electron.exe 跑时（better-sqlite3 是 Electron ABI），脚本结束后必须显式退出，
// 否则 Electron 主进程会挂着不退。
if (process.versions.electron) process.exit(0)
