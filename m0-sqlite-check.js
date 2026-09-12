// M0-4: better-sqlite3 + Electron ABI 验证脚本
// 运行方式: node_modules/electron/dist/electron.exe m0-sqlite-check.js --no-sandbox
const Database = require('better-sqlite3')
const { join } = require('path')

try {
  const dbPath = join(__dirname, 'm0-check.db')
  const db = new Database(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello-electron')
  const row = db.prepare('SELECT v FROM t LIMIT 1').get()
  console.log('SQLITE_OK runtime=' + process.versions.node + ' electron=' + (process.versions.electron || 'n/a') + ' abi=' + process.versions.modules + ' row=' + row.v)
  db.close()
  process.exit(0)
} catch (err) {
  console.error('SQLITE_FAIL', err.message)
  process.exit(1)
}
