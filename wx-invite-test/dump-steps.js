/** 打印最近一次「达人邀约」运行的 results（步骤执行结果 + payload） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  const ev = (expr) => new Promise((ok, err) => {
    const id = Math.floor(Math.random() * 1e9)
    const on = e => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      if (m.error) return err(new Error(JSON.stringify(m.error)))
      if (m.result?.exceptionDetails) return err(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)))
      ok(m.result?.result?.value)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
  const out = await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const tasks = all.filter(t => String(t.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))
    const t = tasks[0]
    const run = t.latestRun || (t.runs || [])[0] || {}
    const res = await window.shopilot.task.results(run.id)
    const steps = res.data.results || res.data.steps || []
    const lines = steps.map(s => ({
      i: s.stepIndex != null ? s.stepIndex : s.index,
      type: s.stepType || s.type,
      st: s.status,
      payload: s.payload ? (typeof s.payload === 'string' ? s.payload : JSON.stringify(s.payload)).slice(0, 400) : null,
      err: s.errorCode ? s.errorCode + ': ' + String(s.errorMessage || '').slice(0, 160) : null
    }))
    return JSON.stringify({ runId: run.id, status: run.status, lines }, null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
