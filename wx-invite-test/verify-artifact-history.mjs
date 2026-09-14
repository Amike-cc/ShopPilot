/**
 * 补验两项（前一轮因测试设计不当而未覆盖）：
 *   ① 截图产物落盘 —— 起一个**能跑到 screenshot** 的短任务（1 轮不发送），跑完看产物
 *   ② 面板历史卡片 —— 任务名用面板同款前缀「达人邀约 · 微信小店 · 辅助填单 · X」，再查卡片
 * 用法：node verify-artifact-history.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const SQUARE_PATH = '/shop/findersquare/find'

const ROUND = [
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  { type: 'clickByText', input: { text: '详情', deep: true, mode: 'real', nth: 'unvisited', missingCode: 'TASK_PAGE_EXHAUSTED', followTab: { urlIncludes: 'finder-detail', closeOld: false } }, timeoutMs: 40000 },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 },
  { type: 'clickByText', input: { text: '邀请带货', deep: true, mode: 'real', missingCode: 'TASK_DAREN_PAGE_UNOPENABLE', waitUrl: { includes: 'initiate-invite', attempts: 4 } }, timeoutMs: 60000 },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 45000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }
]
const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 45000 },
  { type: 'loop', input: { label: '产物与历史验证（不发送，1 轮）'.slice(0, 60), maxRounds: 1, stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'], onCode: [{ code: 'TASK_PAGE_EXHAUSTED', limit: 10, steps: [{ type: 'clickByText', input: { text: '下一页', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL', disabledCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 }, { type: 'waitMs', input: { ms: 3000 }, timeoutMs: 15000 }] }, { code: 'TASK_DAREN_PAGE_UNOPENABLE', limit: 6, restart: true, steps: [{ type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }, { type: 'waitMs', input: { ms: 20000 }, timeoutMs: 30000 }] }], steps: ROUND } }
]

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
for (const id of tabs) await ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {})
await sleep(1200)

// 用面板同款前缀，面板历史才会收录
const TITLE = '达人邀约 · 微信小店 · 辅助填单 · 产物验证'
const old = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>String(t.name).startsWith('达人邀约 · 微信小店 · 辅助填单 · 产物验证')).map(t=>t.id))})()`))
for (const id of old) await ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

const created = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.create({ name: ${JSON.stringify(TITLE)}, storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
  return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
})()`))
console.log('create:', JSON.stringify(created))
if (!created.ok) process.exit(1)
console.log('run:', await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok})})()`))

let runId = null, status = ''
for (let i = 0; i < 60; i++) {
  await sleep(4000)
  const st = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
    const run = t && (t.latestRun || (t.runs || [])[0] || {})
    return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0,160) : null, runId: run.id })
  })()`))
  if (st.runId) runId = st.runId
  status = st.status
  if (['succeeded', 'failed', 'cancelled'].includes(status)) { console.log('结束:', JSON.stringify(st)); break }
}
check('任务成功跑完（未发送）', status === 'succeeded', 'status=' + status)

const res = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.results('${runId}')
  const all = (r.data && r.data.results) || []
  const arts = all.filter(x => x.artifact)
  return JSON.stringify({ 步骤结果数: all.length, 带产物数: arts.length, 产物: arts.map(a => String(a.artifact.path).split(/[\\\\/]/).pop()) })
})()`))
console.log('产物:', JSON.stringify(res))
check('截图产物已落盘', (res.带产物数 || 0) > 0, JSON.stringify(res.产物))

// 面板历史卡片（需要面板在「任务 → 达人邀约」）
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2500)
const cards = JSON.parse(await ev(`(() => {
  const cs = [...document.querySelectorAll('[data-test=invite-history-card]')]
  return JSON.stringify({ 历史卡片数: cs.length, 含本次: cs.some(c => String(c.innerText||'').includes('产物验证')), 首张: cs.length ? String(cs[0].innerText||'').replace(/\\s+/g,' ').slice(0, 120) : null })
})()`))
console.log('面板历史:', JSON.stringify(cards))
check('面板历史收录本次运行', cards.含本次 === true, JSON.stringify(cards))

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
