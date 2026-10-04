/**
 * 往**探针副本**的库里注入"近 7 天已邀"台账，用于验证"跳过已邀达人"这条规则。
 * 只动探针库（.probe-wx-profile），不碰真实应用的库。
 *
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe wx-invite-test\seed-probe-ledger.cjs [昵称1 昵称2 ...]
 */
const path = require('node:path')
const Database = require('better-sqlite3')

const dbPath = path.resolve('.probe-wx-profile/shopilot.db')
const storeId = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
// 昵称来源：命令行参数，或 --file <json>（{names:[...]}，由 probe-seed-current-page.mjs 产出）
let nicknames = process.argv.slice(2)
const fileArg = nicknames.indexOf('--file')
if (fileArg >= 0) {
  const file = nicknames[fileArg + 1]
  const parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
  nicknames = Array.isArray(parsed) ? parsed : (parsed.names || [])
}
if (!nicknames.length) { console.error('用法: seed-probe-ledger.cjs <昵称...> | --file <json>'); process.exit(1) }

const db = new Database(dbPath)
db.exec(`CREATE TABLE IF NOT EXISTS invite_history (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, nickname TEXT NOT NULL,
  finder_username TEXT, task_id TEXT, run_id TEXT, invited_at INTEGER NOT NULL
)`)
db.prepare('DELETE FROM invite_history WHERE store_id = ?').run(storeId)
const ins = db.prepare('INSERT INTO invite_history (id, store_id, platform, nickname, finder_username, task_id, run_id, invited_at) VALUES (?,?,?,?,?,?,?,?)')
const now = Date.now()
nicknames.forEach((n, i) => ins.run(`inv_seed_${i}`, storeId, '微信小店', n, `v2_seed_${i}`, null, null, now - (i + 1) * 3600_000))
console.log('探针台账已注入:', db.prepare('SELECT nickname, invited_at FROM invite_history WHERE store_id = ?').all(storeId).map(r => `${r.nickname}@${new Date(r.invited_at).toLocaleTimeString('zh-CN')}`).join(' / '))
db.close()
