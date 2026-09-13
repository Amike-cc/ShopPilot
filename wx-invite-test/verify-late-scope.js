/**
 * 验证"SCOPE_NOT_FOUND 轮询等待"修复：/daren-square?late=1 前 4 秒不渲染筛选区，
 * clickByText（within 限定）应等到它出现后再点成功；若还是立即失败则说明修复无效。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'

const STEPS = [
  { type: 'navigate', input: { url: 'http://127.0.0.1:8899/daren-square?late=1' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'daren-square' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '生鲜', within: { selector: '.quick-filter-button-enums' } }, timeoutMs: 20000 }
]

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
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const t0 = Date.now()
  const created = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '验证 · 筛选区延迟渲染', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  if (!created.ok) { console.log('create failed:', created.err); process.exit(1) }
  await ev(`(async()=>{await window.shopilot.task.run('${created.taskId}');return 1})()`)
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const st = JSON.parse(await ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${created.taskId}')
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage, runId: run.id })
    })()`))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('RESULT:', st.status, st.code || '', (st.msg || '').slice(0, 120), '| elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's')
      // 清理
      await ev(`(async()=>{await window.shopilot.task.delete('${created.taskId}');return 1})()`)
      process.exit(st.status === 'succeeded' ? 0 : 1)
    }
  }
  console.log('TIMEOUT waiting for run')
  process.exit(1)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
