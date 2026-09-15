/** 打印 run 的 errorMessage（中文直接写文件，避免控制台乱码）。 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const RUN = process.argv[2]
const OUT = process.argv[3] || 'wx-invite-test/run-msg.txt'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? null : r.result?.value
}
const raw = await ev("(async () => { const r = await window.shopilot.task.results(" + JSON.stringify(RUN) + "); return JSON.stringify(r.data.run) })()")
const run = JSON.parse(raw)
const lines = [
  `status: ${run.status}`,
  `errorCode: ${run.errorCode}`,
  `errorMessage: ${run.errorMessage}`,
  `statusReason: ${run.statusReason}`,
  `用时: ${run.finishedAt ? run.finishedAt - run.startedAt : '?'} ms`
]
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.map(l => l.replace(/[^\x20-\x7E]/g, '?')).join('\n'))
ws.close()
setTimeout(() => process.exit(0), 200)
