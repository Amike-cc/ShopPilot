/**
 * 跑到门禁就放行（真实发送）：轮询运行状态，waiting_confirmation 时点「允许」。
 * 用法：node approve-send.js [最多轮数] [间隔ms]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ROUNDS = Number(process.argv[2] || 60)
const GAP = Number(process.argv[3] || 5000)

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
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const state = `(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const tasks = all.filter(x => String(x.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))
    const t = tasks[0]
    if (!t) return JSON.stringify({ none: true })
    const run = t.latestRun || (t.runs || [])[0] || {}
    const deny = document.querySelector('[data-test=confirm-deny]')
    return JSON.stringify({ name: t.name, runId: run.id, status: run.status, hasGate: !!deny })
  })()`
  let approved = false
  for (let i = 0; i < ROUNDS; i++) {
    const d = JSON.parse(await ev(state))
    const stamp = new Date().toLocaleTimeString()
    if (d.none) { console.log(stamp, 'no invite task'); await sleep(GAP); continue }
    console.log(stamp, d.status, d.hasGate ? '(gate visible)' : '')
    if (d.status === 'waiting_confirmation' && !approved) {
      const clicked = await ev(`(() => { const b = document.querySelector('[data-test=confirm-allow]'); if (!b) return 'no-btn'; b.click(); return 'allowed' })()`)
      console.log('>>> APPROVE:', clicked)
      approved = true
    }
    if (['succeeded', 'failed', 'cancelled'].includes(d.status)) { console.log('TERMINAL:', d.status); break }
    await sleep(GAP)
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
