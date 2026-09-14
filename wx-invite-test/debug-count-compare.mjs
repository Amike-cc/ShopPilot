/**
 * 验证：Electron 的 ses.cookies.get({}) 在这个版本下对分区 session 返回空，
 * 而带 url 过滤能读到——用主进程侧能力直接试（通过 IPC 无法试，故用 /json + CDP 代理）。
 * 这里改用「会话导入」同款调用路径的对照：直接看 window.shopilot.session.export 的 cookieCount。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

// 用 electron 自带的 node 直接在**主进程之外**无法访问 app；所以这里换思路：
// 让主进程自己报数——调用 exportSessionPackage 会记录 cookieCount（写审计）。但会弹密码框。
// 更简单：读主进程日志里我们自己的 "会话已恢复/快照" 条数，与 CDP 的真实条数对比。
const fs = await import('fs'), path = await import('path')
const log = fs.readFileSync(path.join(process.env.APPDATA, 'shopilot', 'logs', 'app-2026-09-14.log'), 'utf8').split(/\r?\n/)
console.log('=== 日志里我们自己的计数 ===')
for (const l of log.filter(x => /cookies=|恢复|快照/.test(x)).slice(-8)) console.log('  ', l.replace(/^.*\[info\] /, '').slice(0, 160))

// CDP 真实条数
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
const w = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
let s = 0; const q = new Map()
w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id) } }
const sn = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s; q.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
const r = await sn('Network.getAllCookies')
const all = r.cookies || []
console.log('\n=== CDP 实际条数 ===')
console.log('  总数:', all.length, '（会话级:', all.filter(c => c.session).length, '条）')
console.log('  按域名:', JSON.stringify(Object.entries(all.reduce((a, c) => (a[c.domain] = (a[c.domain] || 0) + 1, a), {}))))
w.close()
setTimeout(() => process.exit(0), 300)
