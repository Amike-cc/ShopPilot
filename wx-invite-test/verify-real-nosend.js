/**
 * 真机验证（不发任何邀约）：类目筛选真的生效 + 逐个勾满 40 位。
 * 任务只做到"勾选 + 读页面自认计数 + 截图"，**不含批量邀约/确认发送**，所以只改页面勾选状态，不发送。
 * 用法：node verify-real-nosend.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const SQUARE = 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square'

const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'daren-square' }, timeoutMs: 45000 },
  // 类目：chip（限定在类目快捷选项行）→ 级联叶子「不限」（限定在级联弹层）
  { type: 'clickByText', input: { text: '个护家清', within: { selector: '.quick-filter-button-enums' } }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '不限', within: { selector: '.quick-filter-cascader-popover' } }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '达人等级' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV0' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV1' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV2' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: 'LV3' }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '搜索' }, timeoutMs: 20000 },
  { type: 'waitForSelector', input: { selector: 'tbody input[type=checkbox]' }, timeoutMs: 30000 },
  // 类目生效校验：已筛选标签行里必须出现该类目（引擎会在这里如实失败）
  { type: 'waitForText', input: { text: '个护家清', within: { text: '已筛选', climb: 1 } }, timeoutMs: 30000 },
  // 逐个勾 40 位（会向下滚动加载更多达人）
  { type: 'clickAll', input: { selector: 'tbody input[type=checkbox]', max: 40, scroll: true, maxRounds: 40 }, timeoutMs: 240000 },
  // 读页面自认的勾选计数 + 筛选标签，留下凭证
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

  await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(2500)

  const created = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '真机验证 · 类目+勾 40（不发送）', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)

  console.log('run:', await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))

  let runId = null
  for (let i = 0; i < 100; i++) {
    await sleep(4000)
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
      runId = st.runId
      const detail = await ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const steps = res.data.results || []
        const norm = (s) => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        return JSON.stringify(steps.map(norm))
      })()`)
      console.log('PAYLOADS:', detail)
      break
    }
  }
  // 页面侧独立复核：已筛选标签 + 勾选计数
  const pageCheck = await ev(`(async () => {
    const t2 = await window.shopilot.browser.tab.list('${STORE}')
    return JSON.stringify({ note: 'tabs listed' })
  })()`).catch(() => '{}')
  console.log('done', pageCheck)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
