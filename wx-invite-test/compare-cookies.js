/** 对比两个店铺分区的 Cookie 持久化情况（处理 Chromium 的大时间戳哨兵值） */
const { DatabaseSync } = require('node:sqlite')
const conv = (u) => {
  if (u === 0 || u === null) return '(session-cookie)'
  const n = typeof u==='bigint'?Number(u):u
  if (!Number.isFinite(n) || n > 25340230079900000) return '(远期/哨兵)'
  const ms = n / 1000 - 11644473600000
  const d = new Date(ms)
  return isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 10)
}
const parts = [
  ['抖店', 'store_store_3b4c2823d4d9cf6d0bdea96882ce38cc'],
  ['微信小店测试', 'store_store_4eb9b43cffeee0094041894a9f1f93bf'],
  ['微信仿真店(已删)', 'store_store_d0b3d95b9de6426d5edd142d0ab94ea2']
]
for (const [name, p] of parts) {
  const path = 'C:/Users/15240/AppData/Roaming/shopilot/Partitions/' + p + '/Network/Cookies'
  let db
  try { db = new DatabaseSync(path, { open: true }) } catch (e) { console.log('==', name, '打不开:', e.message.slice(0, 60)); continue }
  const total = db.prepare('SELECT COUNT(*) n FROM cookies').get().n
  console.log('==', name, '总Cookie行数:', total)
  const rows = db.prepare("SELECT host_key,name,is_persistent,CAST(expires_utc AS TEXT) exp FROM cookies ORDER BY host_key,name LIMIT 30").all()
  for (const r of rows) {
    console.log('  ', [r.host_key.padEnd(24), r.name.padEnd(30), r.is_persistent ? ('persist exp=' + conv(BigInt(r.exp))) : 'SESSION-COOKIE'].join(' '))
  }
}
