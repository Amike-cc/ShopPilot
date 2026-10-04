/**
 * 读某个 run 的逐步结果（顶层步骤的 payload 会落库）。
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe wx-invite-test\read-run-steps.cjs <runId>
 */
const path = require('node:path')
const Database = require('better-sqlite3')

const runId = process.argv[2]
if (!runId) { console.error('用法: read-run-steps.cjs <runId>'); process.exit(1) }
const db = new Database(path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db'), { readonly: true })
const run = db.prepare('select id, task_id, status, error_code, substr(error_message,1,200) msg, started_at, finished_at from task_runs where id = ?').get(runId)
console.log('run:', JSON.stringify(run, null, 1))
const rows = db.prepare('select step_index, kind, payload_json, artifact_path, created_at from task_step_results where run_id = ? order by created_at').all(runId)
console.log('步骤结果条数:', rows.length)
for (const r of rows) {
  console.log(`第${r.step_index + 1}步 ${r.kind} ${new Date(Number(r.created_at)).toLocaleTimeString('zh-CN')} ${r.artifact_path ? 'artifact=' + r.artifact_path.split('\\').pop() : ''}`)
  console.log('   ', String(r.payload_json || '').slice(0, 400))
}
const task = db.prepare('select steps from tasks where id = ?').get(run?.task_id)
if (task) console.log('\n任务步骤:', String(task.steps).slice(0, 600))
db.close()
