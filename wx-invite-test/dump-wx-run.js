/** 打印最近一次微信邀约运行的步骤定义与全部步骤结果 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
  const out = await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const t = all.filter(x => String(x.name || '').startsWith('达人邀约'))[0]
    if (!t) return JSON.stringify({ err: 'no task' })
    const run = t.latestRun || (t.runs || [])[0] || {}
    const res = await window.shopilot.task.results(run.id)
    const steps = res.data.results || []
    const norm = s2 => (typeof s2.payload === 'string' ? (() => { try { return JSON.parse(s2.payload) } catch { return { raw: String(s2.payload).slice(0, 120) } } })() : (s2.payload || {}))
    return JSON.stringify({
      name: t.name, storeScope: t.storeScope,
      defs: (t.steps || []).map(s2 => s2.type),
      run: { id: run.id, status: run.status, code: run.errorCode, msg: run.errorMessage, startedAt: run.startedAt, finishedAt: run.finishedAt, currentStep: run.currentStep },
      resultCount: steps.length,
      results: steps.map(norm).slice(0, 20)
    }, null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
