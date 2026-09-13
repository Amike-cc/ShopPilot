/**
 * 用仿真广场验证 loop 的停止语义（不碰真实店铺）：
 *   建任务 → 跑到额度用尽 → 期望：run 成功、loop payload 里 completedRounds=2、stopReason=TASK_QUOTA_EXCEEDED
 * 用法：node verify-loop-mock.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const MOCK = 'http://127.0.0.1:8899'

const ROUND = [
  { type: 'navigate', input: { url: MOCK + '/daren-square' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'daren-square' }, timeoutMs: 30000 },
  { type: 'clickByText', input: { text: '生鲜', within: { selector: '.quick-filter-button-enums' } }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '不限', within: { selector: '.quick-filter-cascader-popover' } }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '达人等级' }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: 'LV0' }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '搜索' }, timeoutMs: 15000 },
  { type: 'waitForSelector', input: { selector: 'tbody input[type=checkbox]' }, timeoutMs: 20000 },
  { type: 'waitForText', input: { text: '生鲜', within: { text: '已筛选', climb: 1 } }, timeoutMs: 20000 },
  { type: 'clickAll', input: { selector: 'tbody input[type=checkbox]', max: 40, scroll: true, maxRounds: 20 }, timeoutMs: 120000 },
  { type: 'clickByText', input: { text: '批量邀约带货' }, timeoutMs: 15000 },
  { type: 'waitForSelector', input: { selector: 'textarea' }, timeoutMs: 20000 },
  { type: 'requireEnabled', input: { text: '确认发送', hint: '额度用尽时按钮禁用' }, timeoutMs: 20000 },
  { type: 'setInput', input: { selector: 'textarea', text: '仿真邀约话术' }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '确认发送' }, timeoutMs: 15000 },
  { type: 'waitForGone', input: { selector: 'textarea' }, timeoutMs: 20000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
]

const STEPS = [{
  type: 'loop',
  input: {
    label: '仿真 · 生鲜 · 每批 40 位',
    maxRounds: 5,
    stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
    steps: ROUND
  }
}]

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  console.log('open store window:', await ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(2500)

  const created = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.create({
      name: '仿真验证 · loop 额度用尽',
      storeScope: '${STORE}',
      steps: ${JSON.stringify(STEPS)}
    })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) { process.exit(1) }

  const run = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.run('${created.taskId}')
    return JSON.stringify({ ok: r.ok, err: r.error && r.error.message, waiting: r.data && r.data.waitingForStore })
  })()`))
  console.log('run:', JSON.stringify(run))

  for (let i = 0; i < 90; i++) {
    await sleep(3000)
    const st = JSON.parse(await ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage, runId: run.id })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      const detail = await ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const steps = res.data.results || []
        const norm = (s) => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        return JSON.stringify(steps.map(norm).filter(p => p.action === 'loop' || p.action === 'clickAll'))
      })()`)
      console.log('PAYLOADS:', detail)
      break
    }
  }
  const mockState = await (await fetch(MOCK + '/state')).json()
  console.log('MOCK STATE:', JSON.stringify(mockState))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
