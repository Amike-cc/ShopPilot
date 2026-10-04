/**
 * 只读排查：从**真实应用**的库里读最近的达人邀约任务/运行/逐步结果。
 * 用法（Electron 自带 node 运行时，better-sqlite3 按 Electron ABI 编译）：
 *   $env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe wx-invite-test\read-real-db.cjs
 */
const path = require('node:path')
const Database = require('better-sqlite3')

const dbPath = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const db = new Database(dbPath, { readonly: true })
const ts = v => (v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '-')

const tasks = db.prepare("select id,name,store_scope,created_at,updated_at from tasks where name like '%邀约%' order by updated_at desc limit 6").all()
console.log('=== 邀约任务（最近 6 个） ===')
for (const t of tasks) console.log(`${t.id}  ${ts(t.updated_at)}  store=${t.store_scope}  ${t.name}`)

const runs = db.prepare(`
  select r.id, r.task_id, r.store_id, r.status, r.current_step, r.started_at, r.finished_at, r.error_code, r.error_message, t.name
  from task_runs r left join tasks t on t.id = r.task_id
  order by coalesce(r.finished_at, r.started_at) desc limit 8`).all()
console.log('\n=== 最近 8 次运行 ===')
for (const r of runs) {
  console.log(`${r.id}  ${r.status.padEnd(10)} ${ts(r.started_at)} → ${ts(r.finished_at)}  step=${r.current_step}  ${r.error_code || ''}`)
  if (r.error_message) console.log(`    ${String(r.error_message).replace(/\s+/g, ' ').slice(0, 400)}`)
  console.log(`    task=${r.name}`)
}

const latestInviteRun = runs.find(r => String(r.name || '').includes('邀约'))
if (latestInviteRun) {
  console.log(`\n=== 失败运行的逐步结果 run=${latestInviteRun.id} ===`)
  const results = db.prepare('select step_index, kind, payload_json, artifact_path, created_at from task_step_results where run_id = ? order by created_at').all(latestInviteRun.id)
  for (const row of results) {
    let payload = ''
    try { payload = JSON.stringify(JSON.parse(row.payload_json)).slice(0, 500) } catch { payload = String(row.payload_json || '').slice(0, 200) }
    console.log(`  第${row.step_index + 1}步 ${row.kind}  ${ts(row.created_at)}  ${row.artifact_path ? 'artifact=' + row.artifact_path : ''}`)
    if (payload && payload !== '{}' && payload !== 'null') console.log(`      ${payload}`)
  }
  const steps = db.prepare('select steps from tasks where id = ?').get(latestInviteRun.task_id)
  if (steps) {
    const parsed = JSON.parse(steps.steps || '[]')
    console.log('\n=== 该任务的步骤清单 ===')
    for (const [i, s] of parsed.entries()) {
      console.log(`  ${i + 1}. ${s.type} ${JSON.stringify(s.input || {}).slice(0, 150)}`)
    }
  }
}
db.close()
