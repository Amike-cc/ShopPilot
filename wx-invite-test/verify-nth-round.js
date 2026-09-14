/**
 * 真机验证 nth:'round'：每轮取列表里第 N 条「详情」（换达人，不重复邀同一人）
 * 仿真广场 12 行 + 右侧固定列镜像 → 跑 3 轮，期望点到达人 1、2、3（服务端记录）
 * 用法：node verify-nth-round.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_TEST_STORE || 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const MOCK = 'http://127.0.0.1:8895'
const ROUNDS = 3

const ROUND = [
  { type: 'navigate', input: { url: MOCK + '/mock-square' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'mock-square' }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  {
    type: 'clickByText',
    input: { text: '详情', deep: true, mode: 'real', nth: 'round', missingCode: 'TASK_SELECTION_SHORTFALL', followTab: { urlIncludes: 'finder-detail' } },
    timeoutMs: 30000
  },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 30000 },
  { type: 'readText', input: { selector: '#row', metric: 'detail.row', deep: true }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
]

const STEPS = [{
  type: 'loop',
  input: { label: `仿真 · nth=round · 每轮换一位（${ROUNDS} 轮）`, maxRounds: ROUNDS, stopOn: ['TASK_SELECTION_SHORTFALL'], steps: ROUND }
}]

async function connect() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.url.includes('out/renderer/index.html'))
  if (!t) throw new Error('没有找到应用主窗口页面')
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
  return { ev }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLE = '仿真 · nth=round 逐轮换达人'

async function main() {
  await fetch(MOCK + '/reset').catch(() => {})
  const app = await connect()
  console.log('打开店铺窗口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(2500)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1200)
  const old = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>t.name==='${TITLE}').map(t=>t.id))})()`))
  for (const id of old) await app.ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '${TITLE}', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  console.log('run:', await app.ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))

  for (let i = 0; i < 60; i++) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 200) : null, runId: run.id })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('loop 汇总:', await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        const all = (res.data.results || []).map(norm)
        return JSON.stringify({ loop: all.find(p => p.action === 'loop'), 点到的第几条: all.filter(p => p.action === 'clickByText').map(p => p.picked), 读到的达人: all.filter(p => p.metric === 'detail.row').map(p => p.text) })
      })()`))
      break
    }
  }
  console.log('MOCK 服务端记录:', await (await fetch(MOCK + '/state')).text())
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
