// 验证 shopilot.db 迁移结果：列出所有表 + schema_migrations
const Database = require('better-sqlite3')
const path = require('path')

const dbPath = path.join(process.env.APPDATA, 'shopilot', 'shopilot.db')
const db = new Database(dbPath, { readonly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
console.log('TABLES(' + tables.length + '): ' + tables.map(t => t.name).join(', '))

const migrations = db.prepare('SELECT version, name, applied_at FROM schema_migrations').all()
console.log('MIGRATIONS: ' + JSON.stringify(migrations))

const journal = db.pragma('journal_mode')
console.log('JOURNAL_MODE: ' + JSON.stringify(journal))
const fk = db.pragma('foreign_keys')
console.log('FOREIGN_KEYS: ' + JSON.stringify(fk))

db.close()
