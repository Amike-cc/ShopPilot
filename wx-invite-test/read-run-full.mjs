/** 完整打印 run 的 loop payload（不过截断），看清每轮为什么停。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const RUN = process.argv[2]
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
}
const res = await ev("(async () => { const r = await window.shopilot.task.results(" + JSON.stringify(RUN) + "); return JSON.stringify(r) })()")
const parsed = JSON.parse(res)
const rows = parsed.data.results || parsed.data
for (const r of (Array.isArray(rows) ? rows : [])) {
  console.log('--- step', r.stepIndex, r.kind, '---')
  console.log(typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload, null, 1))
}
ws.close()
setTimeout(() => process.exit(0), 200)
