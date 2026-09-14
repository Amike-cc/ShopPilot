/** 直接读分区 Cookies 库（SQLite），看持久/会话 Cookie 各自落盘情况 */
const path = await import('path')
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const dbPath = path.join(process.env.APPDATA, 'shopilot', 'Partitions', `store_${STORE}`, 'Network', 'Cookies')
const Database = (await import('better-sqlite3')).default
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
console.log('库文件:', dbPath)
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
console.log('表:', tables.join(', '))
const cols = db.prepare('PRAGMA table_info(cookies)').all().map(c => c.name)
console.log('cookies 列:', cols.join(', '))
const all = db.prepare('SELECT name, host_key, path, is_persistent, has_expires, length(value) AS vlen, expires_utc FROM cookies').all()
console.log('总行数:', all.length)
console.log('按 host 统计:')
const byHost = {}
for (const r of all) byHost[r.host_key] = (byHost[r.host_key] || 0) + 1
for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${n}  ${h}`)
console.log('probe 相关:', JSON.stringify(all.filter(r => /shopilot_probe/.test(r.name)), null, 1))
console.log('is_persistent 分布:', JSON.stringify(all.reduce((a, r) => (a[r.is_persistent] = (a[r.is_persistent] || 0) + 1, a), {})))
console.log('weixin 域下抽样 5 条:')
for (const r of all.filter(x => /weixin/.test(x.host_key)).slice(0, 5)) console.log('   ', JSON.stringify(r))
db.close()
