/** 真机不发送验证：二级类目（个护家清/家清纸品）筛选生效 + 勾 40 位（任务不含发送步骤） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const SQUARE = 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square'

const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'daren-square' }, timeoutMs: 45000 },
  { type: 'clickByText', input: { text: '个护家清', within: { selector: '.quick-filter-button-enums' } }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '家清纸品', within: { selector: '.quick-filter-cascader-popover' } }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '达人等级' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV0' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV1' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV2' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV3' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '搜索' }, timeoutMs: 20000 },
  { type: 'waitForSelector', input: { selector: 'tbody input[type=checkbox]' }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '个护家清', within: { text: '已筛选', climb: 1 } }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '家清纸品', within: { text: '已筛选', climb: 1 } }, timeoutMs: 30000 },
  { type: 'clickAll', input: { selector: 'tbody input[type=checkbox]', max: 40, scroll: true, maxRounds: 40 }, timeoutMs: 240000 },
  { type: 'readText', input: { selector: '.select_peoples_message', metric: 'invite.selectedCount' }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
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
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(2500)
  const created = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '真机验证 · 二级类目（不发送）', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  console.log('run:', await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))
  for (let i = 0; i < 90; i++) {
    await sleep(4000)
    const st = JSON.parse(await ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 120) : null, runId: run.id })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      if (st.runId) {
        const detail = await ev(`(async () => {
          const res = await window.shopilot.task.results('${st.runId}')
          const steps = res.data.results || []
          const norm = (s) => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
          return JSON.stringify(steps.map(norm).map(p => p.action ? { action: p.action, matched: p.matched, clickedText: p.clickedText, selected: p.selected, requested: p.requested, pageSelected: p.pageSelected, text: p.text } : p))
        })()`)
        console.log('PAYLOADS:', detail)
      }
      await ev(`(async()=>{await window.shopilot.task.delete('${created.taskId}');return 1})()`)
      process.exit(st.status === 'succeeded' ? 0 : 1)
    }
  }
  process.exit(1)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
