#!/usr/bin/env node
/**
 * 一次性清理"同名重复的采集任务"（2026-10-15 审查 D）。
 *
 * 背景：早期版本每次点「采集」都新建任务，同一家店积压一长串同名任务
 * （实测：46 个「发票采集 ·」里 41 个是积压，含已删店 1111 的 12 个孤儿；
 * 「主体信息采集 ·」也有 6 个积压）。现行代码已改为"认领最新的同一个任务"
 * （UnifiedDataPage.ensureCollectTask → shared.pickLatestCollectTask），不会再新增，本脚本清理历史积压。
 *
 * 规则（保守、可重复执行）：
 *   · 只处理 5 个采集类前缀（发票 / 涉税报送 / 主体信息 / 经营指标 / 订单明细——
 *     后两个前缀以源码 collectTaskName 为准，避免动到别的子系统建的任务）；
 *   · 每家店每类只保留 updated_at 最新的一个（与界面认领口径一致）；
 *   · 任务有未结束运行（queued / running / waiting_confirmation / paused）的**跳过不删**；
 *   · 默认 dry-run 只打印计划；--apply 才删除，删除前用 SQLite `VACUUM INTO`
 *     把整库备份到同目录（备份 API 而非文件拷贝：应用可能开着，WAL 里还有未 checkpoint 的提交）；
 *   · 删除语义 = App 的 TaskStore.deleteTask：任务行 + 级联的 steps / runs / step_results。
 *
 * 用法（Node ≥ 22.5，使用内置 node:sqlite，不依赖 better-sqlite3 的 Electron ABI）：
 *   node tools/maintenance/cleanup-duplicate-collect-tasks.mjs                 # dry-run（默认）
 *   node tools/maintenance/cleanup-duplicate-collect-tasks.mjs --apply         # 执行
 *   node tools/maintenance/cleanup-duplicate-collect-tasks.mjs --db <路径>      # 指定库
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 处理哪些前缀。前 5 个与源码一致（collectTaskName / INVOICE_TASK_PREFIX /
 * TAX_TASK_PREFIX / ENTITY_TASK_PREFIX）；最后一个 `经营数据采集 ·` 是**旧版命名**
 * （2026-09-13 那批带日期后缀的遗留；2026-10-15 全库 grep 确认无任何代码再引用它），
 * 同属"同名重复积压"，一并按同一规则清理。
 */
const COLLECT_PREFIXES = [
  '发票采集 ·',
  '涉税报送采集 ·',
  '主体信息采集 ·',
  '经营指标采集 ·',
  '订单明细采集 ·',
  '经营数据采集 ·'
]

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_confirmation', 'paused']

function defaultDbPath() {
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'shopilot', 'shopilot.db')
  return join(homedir(), '.config', 'shopilot', 'shopilot.db')
}

function parseArgs(argv) {
  const args = { apply: false, db: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true
    else if (argv[i] === '--db') args.db = argv[++i] || ''
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const dbPath = args.db || defaultDbPath()
if (!dbPath || !existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath || '(空路径)'}`)
  console.error('用 --db <路径> 指定。Windows 默认 %APPDATA%/shopilot/shopilot.db')
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: !args.apply })

// ---------- 1) 扫描候选 ----------
const all = db.prepare('SELECT id, name, store_scope, status, created_at, updated_at FROM tasks ORDER BY created_at DESC').all()
const groups = new Map() // key: store_scope \0 前缀 → 候选任务（含前5个前缀的）
let scanned = 0
for (const t of all) {
  const name = String(t.name || '')
  const prefix = COLLECT_PREFIXES.find(p => name.startsWith(p))
  if (!prefix) continue
  scanned++
  const key = `${t.store_scope}\u0000${prefix}`
  if (!groups.has(key)) groups.set(key, { prefix, storeScope: t.store_scope, tasks: [] })
  groups.get(key).tasks.push(t)
}

// ---------- 2) 每组挑"保留哪一个"，其余进删除候选 ----------
const activeRunTaskIds = new Set(
  db.prepare(`SELECT DISTINCT task_id FROM task_runs WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`)
    .all(...ACTIVE_RUN_STATUSES).map(r => r.task_id)
)
const storeNames = new Map(db.prepare('SELECT id, name, deleted_at FROM stores').all().map(s => [s.id, s]))

const fmtTime = ms => new Date(Number(ms) || 0).toLocaleString('zh-CN', { hour12: false })
const storeLabel = id => {
  const s = storeNames.get(id)
  if (!s) return `(店铺已不存在：${id})`
  return s.deleted_at ? `${s.name}（已删除/回收站）` : s.name
}

const toDelete = []
const skipped = []
const keptLog = []
for (const { storeScope, tasks } of groups.values()) {
  if (tasks.length < 2) continue
  // 保留：updated_at 最新（平手取 created_at 最新）
  const sorted = [...tasks].sort((a, b) =>
    (Number(a.updated_at) - Number(b.updated_at)) || (Number(a.created_at) - Number(b.created_at)))
  const keep = sorted[sorted.length - 1]
  keptLog.push(`保留  [${storeLabel(storeScope)}] ${keep.name}（updated ${fmtTime(keep.updated_at)}）`)
  for (const t of tasks) {
    if (t.id === keep.id) continue
    if (activeRunTaskIds.has(t.id)) { skipped.push(t); continue }
    toDelete.push(t)
  }
}

const runCount = db.prepare('SELECT COUNT(*) c FROM task_runs WHERE task_id = ?')
for (const t of toDelete) t.runs = runCount.get(t.id).c

// ---------- 3) 输出计划 ----------
console.log(`库：${dbPath}`)
console.log(`模式：${args.apply ? 'APPLY（将删除）' : 'DRY-RUN（只打印，不改动）'}`)
console.log(`采集类任务共 ${scanned} 个；重复组 ${keptLog.length} 组`)
console.log('')
if (keptLog.length) {
  console.log('—— 每组保留 ——')
  for (const line of keptLog) console.log(line)
  console.log('')
}
console.log(`—— 计划删除 ${toDelete.length} 个（连同各自的运行记录）——`)
for (const t of toDelete) {
  console.log(`删除  [${storeLabel(t.store_scope)}] ${t.name}（updated ${fmtTime(t.updated_at)}，runs ${t.runs}）`)
}
if (skipped.length) {
  console.log('')
  console.log(`—— 跳过 ${skipped.length} 个（有未结束的运行，先留着）——`)
  for (const t of skipped) console.log(`跳过  [${storeLabel(t.store_scope)}] ${t.name}`)
}

if (!toDelete.length) {
  console.log('\n没有可清理的重复任务。')
  db.close()
  process.exit(0)
}

if (!args.apply) {
  console.log('\n这是 dry-run。确认无误后加 --apply 执行（会先备份整库）。')
  db.close()
  process.exit(0)
}

// ---------- 4) 备份 + 删除（必须显式给 --apply 才走到这里） ----------
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) // yyyyMMddHHmmss
const backupPath = `${dbPath}.backup-${stamp}`
if (existsSync(backupPath)) {
  console.error(`备份文件已存在，停止：${backupPath}`)
  process.exit(1)
}
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
console.log(`\n已备份整库：${backupPath}`)

const delStepResults = db.prepare('DELETE FROM task_step_results WHERE run_id IN (SELECT id FROM task_runs WHERE task_id = ?)')
const delRuns = db.prepare('DELETE FROM task_runs WHERE task_id = ?')
const delSteps = db.prepare('DELETE FROM task_steps WHERE task_id = ?')
const delTask = db.prepare('DELETE FROM tasks WHERE id = ?')
db.exec('BEGIN IMMEDIATE')
try {
  for (const t of toDelete) {
    delStepResults.run(t.id)
    delRuns.run(t.id)
    delSteps.run(t.id)
    delTask.run(t.id)
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('删除失败，已回滚（库未改动）：', err.message)
  process.exit(1)
}

const remain = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE ${COLLECT_PREFIXES.map(() => "name LIKE ?").join(' OR ')}`)
  .get(...COLLECT_PREFIXES.map(p => `${p}%`)).c
console.log(`已删除 ${toDelete.length} 个任务（含运行记录）。当前采集类任务剩余 ${remain} 个。`)
console.log('可以再跑一次 dry-run 复核（应显示"没有可清理的重复任务"）。')
db.close()
