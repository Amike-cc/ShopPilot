/** 完整 dump 某次 run 的步骤结果（含 artifactPath/sha256/summary），判断截图工件是否已落库 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const runId = process.argv[2]
if (!runId) { console.log('用法: node dump-run-rows.mjs <runId>'); process.exit(1) }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log(await ev(`(async () => {
  const r = await window.shopilot.task.results('${runId}')
  const all = (r.data && r.data.results) || []
  return JSON.stringify(all.map(x => ({
    idx: x.stepIndex, kind: x.kind, summary: String(x.summary || '').slice(0, 80),
    artifactPath: x.artifactPath || null,
    sha: x.artifactSha256 ? String(x.artifactSha256).slice(0, 10) : null
  })), null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
