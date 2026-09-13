/** 打印最近一次「达人邀约」运行的步骤与 payload（重点 clickAll） */
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

  const shape = await ev(`(async () => {
    const r = await window.shopilot.task.list()
    return JSON.stringify({ topKeys: Object.keys(r), dataType: Array.isArray(r.data) ? 'array' : typeof r.data, dataKeys: r.data && !Array.isArray(r.data) ? Object.keys(r.data) : null, len: Array.isArray(r.data) ? r.data.length : (r.data?.tasks || []).length })
  })()`)
  console.log('LIST SHAPE:', shape)

  const out = await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : (r.data.tasks || r.data.items || [])
    const tasks = all.filter(t => String(t.name || '').startsWith('\\u8fbe\\u4eba\\u9080\\u7ea6'))
    if (!tasks.length) return JSON.stringify({ err: 'no invite task', names: all.map(x => x.name).slice(0, 10) })
    const t = tasks[0]
    const run = t.latestRun || (t.runs || [])[0] || {}
    let res = null
    try { res = await window.shopilot.task.results(run.id) } catch (e) { res = { err: String(e) } }
    const rd = res && res.data ? res.data : res
    return JSON.stringify({ name: t.name, runId: run.id, status: run.status, resultKeys: rd && typeof rd === 'object' ? Object.keys(rd) : null, blob: JSON.stringify(rd).slice(0, 2500) })
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
