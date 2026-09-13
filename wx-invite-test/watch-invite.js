/**
 * 轮询邀约运行状态：打印每个步骤的状态与 payload（重点看 clickAll）。
 * 用法：node watch-invite.js [轮数] [间隔ms]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ROUNDS = Number(process.argv[2] || 40)
const GAP = Number(process.argv[3] || 5000)

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return (await r.json()).filter(t => t.type === 'page')
}
async function ev(ws, expr) {
  return new Promise((ok, err) => {
    const id = Math.floor(Math.random() * 1e9)
    const on = e => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', on)
      if (m.error) return err(new Error(JSON.stringify(m.error)))
      if (m.result?.exceptionDetails) return err(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)))
      ok(m.result?.result?.value)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const list = await targets()
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  const q = `(async () => {
    const r = await window.shopilot.task.list()
    const tasks = (r.data.tasks || r.data || []).filter(t => String(t.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))
    const t = tasks[0]
    if (!t) return JSON.stringify({ none: true, all: (r.data.tasks || []).map(x => x.name) })
    const run = t.latestRun || t.runs?.[0]
    if (!run) return JSON.stringify({ name: t.name, noRun: true })
    const res = await window.shopilot.task.results(run.id)
    const steps = (res.data.steps || res.data.stepResults || []).map((s, i) => ({
      i, type: s.stepType || s.type, st: s.status,
      payload: s.payload ? JSON.stringify(s.payload).slice(0, 320) : null,
      err: s.error ? String(s.error).slice(0, 200) : null
    }))
    return JSON.stringify({ name: t.name, runId: run.id, status: run.status, error: run.errorCode || null, msg: run.errorMessage || null, steps })
  })()`
  for (let i = 0; i < ROUNDS; i++) {
    const raw = await ev(ws, q)
    const d = JSON.parse(raw)
    const stamp = new Date().toLocaleTimeString()
    if (d.none) { console.log(stamp, 'no invite task yet:', d.all); await sleep(GAP); continue }
    console.log('---', stamp, d.name, '| status:', d.status, d.error || '', d.msg ? '(' + d.msg.slice(0, 90) + ')' : '')
    for (const s of d.steps || []) {
      if (['succeeded', 'failed', 'executed', 'waiting', 'running'].includes(s.st) || s.err) {
        console.log('   ', s.i + 1, s.type, s.st, s.payload ? s.payload : '', s.err ? 'ERR ' + s.err : '')
      }
    }
    if (['succeeded', 'failed', 'cancelled'].includes(d.status)) { console.log('TERMINAL:', d.status); break }
    await sleep(GAP)
  }
  process.exit(0)
})()
