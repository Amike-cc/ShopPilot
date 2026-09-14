/** 用正确的返回字段（items）复核 Cookie 查看器是否正常 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await new Promise(r => setTimeout(r, 4000))
console.log('Cookie 查看器:', await ev(`(async()=>{
  const r = await window.shopilot.session.cookies('${STORE}')
  const d = r.data || {}
  return JSON.stringify({ ok: r.ok, total: d.total, items: (d.items||[]).length, sample: (d.items||[]).slice(0,5).map(i=>i.name+'@'+i.domain+(i.session?' [会话]':'')) })
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
