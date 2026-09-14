/** 诊断发票采集任务：列出「发票采集 ·」任务的运行结果与错误 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const out = await ev(`(async () => {
  const r = await window.shopilot.task.list()
  const all = Array.isArray(r.data) ? r.data : (r.data.tasks || [])
  const inv = all.filter(t => String(t.name||'').startsWith('发票采集'))
  return JSON.stringify(inv.map(t => {
    const run = t.latestRun || (t.runs||[])[0] || {}
    return { name: t.name, status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0,220) : null, runId: run.id, steps: (t.steps||[]).map(x => x.type) }
  }), null, 1)
})()`)
console.log('发票采集任务:', out)
const parsed = JSON.parse(out)
for (const t of parsed) {
  if (!t.runId) continue
  const res = await ev(`(async () => {
    const r = await window.shopilot.task.results('${t.runId}')
    const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
    return JSON.stringify((r.data.results||[]).map(x => ({ idx: x.stepIndex, kind: x.kind, action: norm(x).action || norm(x).stepType || null, rows: norm(x).rowCount, metric: norm(x).metric, preview: x.summary ? String(x.summary).slice(0,80) : null })), null, 1)
  })()`)
  console.log(`\n[${t.name}] 步骤结果:`); console.log(res)
}
ws.close()
setTimeout(() => process.exit(0), 300)
