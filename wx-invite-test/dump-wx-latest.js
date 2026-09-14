/** 取"最近开始的一次邀约运行"（按 startedAt 倒序），打印步骤定义与结果 */
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
    const tasks = all.filter(x => String(x.name || '').startsWith('达人邀约'))
      .map(t => { const run = t.latestRun || (t.runs || [])[0] || {}; return { t, run } })
      .sort((a, b) => (b.run.startedAt || 0) - (a.run.startedAt || 0))
    const top = tasks[0]
    if (!top) return JSON.stringify({ err: 'no task' })
    const res = await window.shopilot.task.results(top.run.id)
    const steps = res.data.results || []
    const norm = s2 => (typeof s2.payload === 'string' ? (() => { try { return JSON.parse(s2.payload) } catch { return {} } })() : (s2.payload || {}))
    return JSON.stringify({
      name: top.t.name,
      startedAt: new Date(top.run.startedAt || 0).toLocaleString(),
      status: top.run.status, code: top.run.errorCode, msg: top.run.errorMessage ? String(top.run.errorMessage).slice(0, 200) : null,
      defs: (top.t.steps || []).map(s2 => s2.type),
      results: steps.map(norm)
    }, null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
