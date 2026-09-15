/** 只打印每个步骤的 kind/payload 摘要（跳过 input），用于确认到底执行了哪些步骤。 */
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
const run = parsed.data.run
console.log('run:', run.status, '| 用时', run.finishedAt - run.startedAt, 'ms |', run.statusReason)
console.log('\n=== 步骤执行结果 ===')
for (const st of (parsed.data.stepResults || parsed.data.results || [])) {
  const p = typeof st.payload === 'string' ? st.payload : JSON.stringify(st.payload)
  console.log(`  [${st.stepIndex}] ${st.kind}  ${String(p).slice(0, 260)}`)
}
if (!(parsed.data.stepResults || parsed.data.results || []).length) {
  console.log('（没有 stepResults 字段，可用字段:', Object.keys(parsed.data).join(','), '）')
  console.log(JSON.stringify(parsed.data).slice(0, 2500))
}
ws.close()
setTimeout(() => process.exit(0), 200)
