/**
 * 只读：某店铺的任务/运行概览 + 全库"达人邀约"任务清单（排查快手等店铺用）。
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; electron.exe wx-invite-test\read-store-tasks.cjs <storeId>
 */
const path = require('node:path')
const Database = require('better-sqlite3')

const storeId = process.argv[2] || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const db = new Database(path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db'), { readonly: true })
const ts = v => (v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '-')

const store = db.prepare('select id, name, platform from stores where id = ?').get(storeId)
console.log('店铺:', JSON.stringify(store))
console.log('标签页数:', db.prepare('select count(*) c from tabs where store_id = ?').get(storeId).c)

const tasks = db.prepare('select id, name, updated_at from tasks where store_scope = ? order by updated_at desc limit 8').all(storeId)
console.log('\n=== 该店铺的任务 ===')
for (const t of tasks) console.log(' ', t.id, ts(t.updated_at), t.name)

const runs = db.prepare(`
  select r.id, r.status, r.error_code, substr(r.error_message,1,150) m, r.started_at, t.name
  from task_runs r join tasks t on t.id = r.task_id
  where t.store_scope = ? order by r.started_at desc limit 8`).all(storeId)
console.log('\n=== 该店铺的运行 ===')
for (const r of runs) console.log(' ', r.status, r.error_code || '-', ts(r.started_at), '|', r.name, '|', r.m || '')

console.log('\n=== 全库"达人邀约"任务（按店铺）===')
const inviteTasks = db.prepare("select id, name, store_scope, updated_at from tasks where name like '%达人邀约%' order by updated_at desc limit 12").all()
for (const t of inviteTasks) console.log(' ', t.store_scope, ts(t.updated_at), t.name)

console.log('\n=== 各店铺的邀约配置键 ===')
for (const row of db.prepare("select key, length(value_json) len, updated_at from app_settings where key like 'invite.config.store.%' or key like 'invite.config.%' order by updated_at desc limit 12").all()) {
  console.log(' ', row.key, row.len + 'B', ts(row.updated_at))
}
db.close()
