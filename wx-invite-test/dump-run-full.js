/** dump 某次 run 的全部步骤 payload（调试用） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const runId = process.argv[2]
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const out = await ev(`(async () => {
  const res = await window.shopilot.task.results('${runId}')
  const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return { raw: s.payload } } })() : (s.payload || {}))
  const all = (res.data.results || []).map(r => ({ idx: r.stepIndex, kind: r.kind, ...norm(r) }))
  return JSON.stringify(all, null, 1)
})()`)
console.log(out)
process.exit(0)
