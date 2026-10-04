/**
 * 只读：检查某平台相关 cookie 是否存在/是否过期（排查"登录态失效"用）。
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; electron.exe wx-invite-test\read-cookies.cjs kwaixiaodian [userDataDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const needle = process.argv[2] || 'kwaixiaodian'
const userData = process.argv[3] || path.join(process.env.APPDATA || '', 'shopilot')
const cookiePath = path.join(userData, 'Network', 'Cookies')
if (!fs.existsSync(cookiePath)) { console.log('Cookies 文件不存在:', cookiePath); process.exit(0) }

const db = new Database(cookiePath, { readonly: true })
const rows = db.prepare('select host_key, name, expires_utc, is_secure, is_httponly from cookies where host_key like ? order by host_key').all(`%${needle}%`)
console.log(`userData=${userData}`)
console.log(`${needle} 相关 cookie 条数: ${rows.length}`)
const chromeEpochToMs = v => Math.round(Number(v) / 1000 - 11644473600000)
const now = Date.now()
const byHost = {}
for (const r of rows) byHost[r.host_key] = (byHost[r.host_key] || 0) + 1
console.log('按主机:', JSON.stringify(byHost, null, 1))
for (const host of Object.keys(byHost)) {
  const list = rows.filter(r => r.host_key === host)
  const valid = list.filter(r => !r.expires_utc || chromeEpochToMs(r.expires_utc) > now)
  const soonest = list.map(r => (r.expires_utc ? chromeEpochToMs(r.expires_utc) : Infinity)).sort((a, b) => a - b)[0]
  console.log(` ${host}: ${list.length} 条，未过期 ${valid.length}，最早到期 ${soonest === Infinity ? '会话级(不过期)' : new Date(soonest).toLocaleString('zh-CN')}`)
}
const cps = rows.filter(r => /cps\./.test(r.host_key))
console.log('cps（分销后台）相关:', cps.length, '未过期:', cps.filter(r => !r.expires_utc || chromeEpochToMs(r.expires_utc) > now).length)
db.close()
