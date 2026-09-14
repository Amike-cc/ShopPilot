/**
 * 真实站点「翻页」验证（安全：整轮**不含发送**，只走到表单页就回广场）
 * 目的：20 行/页用尽后能否自动点「下一页」继续取人，直到翻不动。
 * 期望：loop 轮数 > 20（说明翻过页）、payload 里能看到 onCode 恢复记录、run 成功。
 * 用法：node verify-wx-pageturn-real.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const SQUARE_PATH = '/shop/findersquare/find'
const ROUNDS = Number(process.argv[2] || 24)

// 一轮：回广场 → 取一位没处理过的「详情」→ 详情页 → 邀请带货 → 表单页 → 回广场（**不发送**）
const ROUND = [
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  {
    type: 'clickByText',
    input: { text: '详情', deep: true, mode: 'real', nth: 'unvisited', missingCode: 'TASK_PAGE_EXHAUSTED', followTab: { urlIncludes: 'finder-detail', closeOld: false } },
    timeoutMs: 40000
  },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 },
  { type: 'waitMs', input: { ms: 3000 }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '邀请带货', deep: true, mode: 'real' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 45000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }
]

const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 45000 },
  { type: 'waitMs', input: { ms: 3000 }, timeoutMs: 15000 },
  {
    type: 'loop',
    input: {
      label: `翻页验证（不发送，最多 ${ROUNDS} 轮）`.slice(0, 60),
      maxRounds: ROUNDS,
      stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
      onCode: [{
        code: 'TASK_PAGE_EXHAUSTED',
        limit: 10,
        steps: [
          {
            type: 'clickByText',
            input: { text: '下一页', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL', disabledCode: 'TASK_SELECTION_SHORTFALL' },
            timeoutMs: 25000
          },
          { type: 'waitMs', input: { ms: 3000 }, timeoutMs: 15000 }
        ]
      }],
      steps: ROUND
    }
  }
]

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLE = '翻页验证 · 微信 · 不发送'

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
await sleep(1200)
// 清干净标签页，避免 useTab 切到旧页
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
console.log('清理标签页:', tabs.length)
for (const id of tabs) await ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {})
await sleep(1500)

const old = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>t.name==='${TITLE}').map(t=>t.id))})()`))
for (const id of old) await ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

const created = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.create({ name: '${TITLE}', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
  return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
})()`))
console.log('create:', JSON.stringify(created))
if (!created.ok) process.exit(1)
console.log('run:', await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))

const startedAt = Date.now()
let lastStatus = ''
for (let i = 0; i < 200; i++) {
  await sleep(5000)
  const st = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
    if (!t) return JSON.stringify({ gone: true })
    const run = t.latestRun || (t.runs || [])[0] || {}
    return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 200) : null, runId: run.id })
  })()`))
  const secs = Math.round((Date.now() - startedAt) / 1000)
  if (st.status !== lastStatus) { console.log(new Date().toLocaleTimeString(), JSON.stringify(st), `(${secs}s)`); lastStatus = st.status }
  else process.stdout.write(`\r  运行中… ${secs}s `)
  if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
    console.log('\n结果:', await ev(`(async () => {
      const res = await window.shopilot.task.results('${st.runId}')
      const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
      const all = (res.data.results || []).map(norm)
      const loop = all.find(p => p.action === 'loop') || {}
      const rounds = loop.rounds || []
      return JSON.stringify({
        completedRounds: loop.completedRounds,
        stopReason: loop.stopReason,
        有恢复记录的轮次: rounds.filter(r => r.recovered && r.recovered.length).map(r => ({ round: r.round, recovered: r.recovered })),
        每轮结果: rounds.map(r => r.ok ? 'ok' : 'stop:' + r.stop)
      }, null, 1)
    })()`))
    break
  }
}
console.log('\n最终标签页:', await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'').slice(0, 60)))})()`))
setTimeout(() => process.exit(0), 300)
