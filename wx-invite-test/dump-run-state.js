/** 打印最近一次达人邀约运行的状态/错误码/消息，以及任务步骤定义 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
  const out = await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const tasks = all.filter(t => String(t.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))
    const t = tasks[0]
    if (!t) return JSON.stringify({ err: 'no invite task' })
    const run = t.latestRun || (t.runs || [])[0] || {}
    let steps = []
    try { const res = await window.shopilot.task.results(run.id); steps = (res.data.results || []).map(s => ({ idx: s.stepIndex != null ? s.stepIndex : s.index, kind: s.kind, payload: s.payload ? (typeof s.payload === 'string' ? s.payload : JSON.stringify(s.payload)).slice(0, 200) : null, errorCode: s.errorCode || null, errorMessage: s.errorMessage ? String(s.errorMessage).slice(0, 200) : null })) } catch (e) { steps = [{ err: String(e).slice(0, 150) }] }
    return JSON.stringify({
      taskId: t.id, name: t.name, stepsDef: (t.steps || []).map(s => s.type),
      run: { id: run.id, status: run.status, code: run.errorCode, msg: run.errorMessage, currentStep: run.currentStep },
      stepResults: steps
    }, null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
