/**
 * 用 Electron 自带 Node 运行时执行（better-sqlite3 是给它编译的）：
 * 读分区 Cookies 库，看持久/会话 Cookie 落盘情况。
 * 用法：node_modules\electron\dist\electron.exe --no-sandbox -i 不行 → 改用 ELECTRON_RUN_AS_NODE
 */
const path = require('path')
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const dbPath = path.join(process.env.APPDATA, 'shopilot', 'Partitions', `store_${STORE}`, 'Network', 'Cookies')
const Database = require('better-sqlite3')
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
console.log('库文件:', dbPath)
const all = db.prepare('SELECT name, host_key, is_persistent, has_expires, length(value) AS vlen, expires_utc FROM cookies').all()
console.log('总行数:', all.length)
const byHost = {}
for (const r of all) byHost[r.host_key] = (byHost[r.host_key] || 0) + 1
console.log('按 host（前 12）:')
for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(n).padStart(4)}  ${h}`)
console.log('is_persistent 分布:', JSON.stringify(all.reduce((a, r) => (a[r.is_persistent] = (a[r.is_persistent] || 0) + 1, a), {})))
console.log('has_expires 分布:', JSON.stringify(all.reduce((a, r) => (a[r.has_expires] = (a[r.has_expires] || 0) + 1, a), {})))
console.log('probe 记录:', JSON.stringify(all.filter(r => /shopilot_probe/.test(r.name))))
console.log('weixin 抽样:', JSON.stringify(all.filter(x => /weixin/.test(x.host_key)).slice(0, 4)))
db.close()
