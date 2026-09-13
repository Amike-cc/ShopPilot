/** 列出全部达人邀约任务与最近运行（按时间排序），找用户最新一次尝试 */
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
    const rows = []
    for (const t of tasks) {
      const run = t.latestRun || (t.runs || [])[0] || {}
      rows.push({
        taskId: t.id, name: t.name, createdAt: t.createdAt,
        runId: run.id, status: run.status, code: run.errorCode,
        startedAt: run.startedAt, msg: run.errorMessage ? String(run.errorMessage).slice(0, 110) : null
      })
    }
    rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    return JSON.stringify(rows.slice(0, 8), null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
