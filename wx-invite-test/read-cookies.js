/** 读取微信小店测试店铺分区里持久化的 Cookie 与过期时间（判断登录能保持多久） */
const fs = require('fs')
const { DatabaseSync } = require('node:sqlite')
const dir = process.argv[2] || 'C:/Users/15240/AppData/Roaming/shopilot/Partitions/store_store_4eb9b43cffeee0094041894a9f1f93bf/Network/Cookies'
if (!fs.existsSync(dir)) { console.log('no cookies db at', dir); process.exit(0) }
const db = new DatabaseSync(dir, { open: true })
const rows = db.prepare("SELECT host_key,name,is_persistent,expires_utc,last_access_utc FROM cookies WHERE host_key LIKE '%qq.com%' ORDER BY host_key,name").all()
const conv = u => { if (!u) return '(session-cookie)'; const ms = u / 1000 - 11644473600000; const d = new Date(ms); return isNaN(d.getTime()) ? '?' : d.toISOString().replace('T', ' ').slice(0, 16) }
console.log('now =', new Date().toISOString().slice(0, 16).replace('T', ' '))
for (const r of rows) {
  console.log([r.host_key.padEnd(24), r.name.padEnd(34), r.is_persistent ? 'persist  ' : 'SESSION  ', 'exp=' + conv(r.expires_utc), 'acc=' + conv(r.last_access_utc)].join(' '))
}
console.log('total', rows.length)
