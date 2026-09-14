/**
 * 验证 host-only Cookie 的保真度：写入(host-only) → 快照 → 强杀重启 → 域名形态是否仍是 host-only
 * 用法：node verify-hostonly.cjs set|check
 */
const fs = await import('fs')
const path = await import('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const STAMP = path.join('wx-invite-test', 'hostonly-stamp.txt')
const mode = process.argv[2] || 'set'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function appEv() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
}
async function cdpPage() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const pg = pages.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com')) || pages.find(x => x.type === 'page' && x.url.includes('127.0.0.1:8895'))
  if (!pg) return null
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { url: pg.url, send, close: () => ws.close() }
}

const app = await appEv()
await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(4000)
const pg = await cdpPage()
if (!pg) { console.log('没有店铺分区页面'); process.exit(1) }
await pg.send('Network.enable')

if (mode === 'set') {
  const v = String(Date.now())
  // 不传 domain → host-only
  const r = await pg.send('Network.setCookie', { name: 'hostonly_probe', value: v, url: 'https://hostonly-probe.test/', secure: true })
  console.log('写入 host-only Cookie:', JSON.stringify(r), '(值=' + v + ')')
  const now = ((await pg.send('Network.getAllCookies')).cookies || []).find(c => c.name === 'hostonly_probe')
  console.log('写入后形态:', JSON.stringify(now && { domain: now.domain, session: now.session }))
  fs.writeFileSync(STAMP, v)
  console.log('等快照…'); await sleep(9000)
  const snap = path.join(process.env.APPDATA, 'shopilot', 'stores', STORE, 'session-cookies.enc')
  console.log('快照:', fs.existsSync(snap) ? fs.statSync(snap).size + 'B' : '(无)')
} else {
  const want = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : ''
  const all = ((await pg.send('Network.getAllCookies')).cookies || [])
  const c = all.find(x => x.name === 'hostonly_probe')
  console.log('期望值:', want)
  console.log('恢复后形态:', c ? JSON.stringify({ domain: c.domain, value: c.value, session: c.session }) : '(不存在)')
  if (!c) console.log('\n✗ 没幸存')
  else if (c.value !== want) console.log('\n△ 值不同')
  else if (c.domain.startsWith('.')) console.log('\n✗ 幸存了但作用域被放宽成域 Cookie（domain=' + c.domain + '）')
  else console.log('\n✓ host-only 形态保真（domain=' + c.domain + '，值一致）')
}
pg.close(); app.close()
setTimeout(() => process.exit(0), 300)
