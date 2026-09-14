/**
 * 用 CDP 直接读分区 Cookie 判断会话级 Cookie 是否跨重启幸存
 * （IPC 的 session.cookies 在分区 session 上返回空，不能用它判定）
 * 用法：node verify-session-cdp.mjs
 */
const fs = await import('fs')
const path = await import('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const STAMP_FILE = path.join('wx-invite-test', 'session-probe-stamp.txt')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
if (!app) { console.log('应用未运行'); process.exit(1) }
const w0 = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { w0.onopen = ok; w0.onerror = err })
let s0 = 0; const q0 = new Map()
w0.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q0.has(m.id)) { q0.get(m.id)(m); q0.delete(m.id) } }
const s0end = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s0; q0.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w0.send(JSON.stringify({ id, method: m2, params: p2 })) })
await s0end('Runtime.evaluate', { expression: `(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`, returnByValue: true, awaitPromise: true, userGesture: true })
w0.close()
await new Promise(r => setTimeout(r, 5000))

// 用店铺窗口的页面（同分区）读全部 Cookie
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const pg = pages.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com')) || pages.find(x => x.type === 'page' && x.url.includes('127.0.0.1:8895'))
if (!pg) { console.log('没有店铺分区的页面可读 Cookie'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
await send('Network.enable')
const all = (await send('Network.getAllCookies')).cookies || []
const stamp = fs.existsSync(STAMP_FILE) ? fs.readFileSync(STAMP_FILE, 'utf8').trim() : ''
console.log('页面:', String(pg.url).slice(0, 55))
console.log('分区 Cookie 总数:', all.length, '（会话级', all.filter(c => c.session).length, '）')
console.log('按域名:', JSON.stringify(Object.entries(all.reduce((a, c) => (a[c.domain] = (a[c.domain] || 0) + 1, a), {}))))
const probe = all.find(c => c.name === 'shopilot_sess_probe')
console.log('\n探针 Cookie（重启前写入的中性域会话 Cookie）:')
console.log('  期望值:', stamp)
console.log('  实际:', probe ? `${probe.value}（session=${probe.session}, domain=${probe.domain}）` : '(不存在)')
if (probe && probe.value === stamp) console.log('\n✓ 会话级 Cookie 跨重启幸存，值与写入时一致 → 会话持久化生效')
else if (probe) console.log('\n△ 存在但值不同（可能被后续写入覆盖）')
else console.log('\n✗ 没幸存')
// 顺带看看微信登录凭据是否还在（若用户在别处登录过）
for (const n of ['biz_token', 'biz_ticket', 'sessionid', 'wxuin']) {
  const c = all.find(x => x.name === n)
  if (c) console.log(`  微信凭据 ${n}: 存在（domain=${c.domain}, session=${c.session}）`)
}
ws.close()
setTimeout(() => process.exit(0), 300)
