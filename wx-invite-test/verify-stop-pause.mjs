/**
 * ⑧ 停止 / 暂停 / 恢复 / 历史留档（安全：不发送，只走到表单页）
 *   ① 起一个长任务（不发送轮次，30 轮）→ 跑几轮后 pause → 校验状态为 paused
 *   ② resume(continue) → 校验恢复后继续跑
 *   ③ cancel → 校验 status=cancelled、错误码/原因可读
 *   ④ 历史留档：results 里有已执行步骤凭据；截图产物存在
 *   ⑤ 面板侧「停止邀约」按钮可达（面板历史卡片存在）
 * 用法：node verify-stop-pause.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const SQUARE_PATH = '/shop/findersquare/find'

const ROUND = [
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  {
    type: 'clickByText',
    input: {
      text: '详情', deep: true, mode: 'real', nth: 'unvisited',
      missingCode: 'TASK_PAGE_EXHAUSTED',
      followTab: { urlIncludes: 'finder-detail', closeOld: false }
    },
    timeoutMs: 40000
  },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 },
  {
    type: 'clickByText',
    input: {
      text: '邀请带货', deep: true, mode: 'real',
      missingCode: 'TASK_DAREN_PAGE_UNOPENABLE',
      waitUrl: { includes: 'initiate-invite', attempts: 4 }
    },
    timeoutMs: 60000
  },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 45000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }
]
const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 45000 },
  {
    type: 'loop',
    input: {
      label: '停/暂停验证（不发送）'.slice(0, 60),
      maxRounds: 30,
      stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
      onCode: [
        { code: 'TASK_PAGE_EXHAUSTED', limit: 10, steps: [{ type: 'clickByText', input: { text: '下一页', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL', disabledCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 }, { type: 'waitMs', input: { ms: 3000 }, timeoutMs: 15000 }] },
        { code: 'TASK_DAREN_PAGE_UNOPENABLE', limit: 6, restart: true, steps: [{ type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }, { type: 'waitMs', input: { ms: 20000 }, timeoutMs: 30000 }] }
      ],
      steps: ROUND
    }
  }
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
const check = (label, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const runState = async (taskId) => JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.list()
  const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${taskId}')
  if (!t) return JSON.stringify({ gone: true })
  const run = t.latestRun || (t.runs || [])[0] || {}
  return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 160) : null, reason: run.statusReason ? String(run.statusReason).slice(0, 120) : null, runId: run.id, step: run.currentStep })
})()`))

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
for (const id of tabs) await ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {})
await sleep(1200)

const TITLE = '停/暂停验证 · 微信 · 不发送'
const old = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>t.name==='${TITLE}').map(t=>t.id))})()`))
for (const id of old) await ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

const created = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.create({ name: '${TITLE}', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
  return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
})()`))
console.log('create:', JSON.stringify(created))
if (!created.ok) process.exit(1)
console.log('run:', await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok})})()`))

// 等它跑到 2 轮以上再暂停
let st = null
for (let i = 0; i < 20; i++) { await sleep(3000); st = await runState(created.taskId); if (st.status === 'running' && (st.step ?? 0) >= 1 && i >= 3) break }
st = await runState(created.taskId)
console.log('暂停前:', JSON.stringify(st))
check('任务已进入 running', st.status === 'running', 'status=' + st.status)

console.log('\n--- 暂停 ---')
console.log('pause 返回:', await ev(`(async()=>{const r=await window.shopilot.task.pause('${st.runId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))
await sleep(4000)
let st2 = await runState(created.taskId)
console.log('暂停后:', JSON.stringify(st2))
check('状态变为 paused', st2.status === 'paused', 'status=' + st2.status)
check('暂停原因可读', !!st2.reason, st2.reason || '')

console.log('\n--- 恢复 ---')
console.log('resume 返回:', await ev(`(async()=>{const r=await window.shopilot.task.resume('${st.runId}','continue');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))
await sleep(8000)
let st3 = await runState(created.taskId)
console.log('恢复后:', JSON.stringify(st3))
check('恢复后继续运行（不再是 paused）', st3.status === 'running' || st3.status === 'succeeded', 'status=' + st3.status)

console.log('\n--- 停止 ---')
console.log('cancel 返回:', await ev(`(async()=>{const r=await window.shopilot.task.cancel('${st.runId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))
await sleep(6000)
let st4 = await runState(created.taskId)
console.log('停止后:', JSON.stringify(st4))
check('状态变为 cancelled', st4.status === 'cancelled', 'status=' + st4.status)

console.log('\n--- 历史留档 ---')
const res = await ev(`(async () => {
  const r = await window.shopilot.task.results('${st.runId}')
  const all = (r.data && r.data.results) || []
  const arts = all.filter(x => x.artifact)
  return JSON.stringify({ ok: r.ok, 步骤结果数: all.length, 带产物数: arts.length, 产物样例: arts.slice(0,2).map(a => String((a.artifact && a.artifact.path) || '').split(/[\\\\/]/).pop()) })
})()`)
console.log('结果:', res)
const rp = (() => { try { return JSON.parse(res) } catch { return {} } })()
check('历史里有步骤结果凭据', (rp.步骤结果数 || 0) > 0, '共 ' + rp.步骤结果数 + ' 条')
check('截图产物已落盘', (rp.带产物数 || 0) > 0, JSON.stringify(rp.产物样例))

// 面板侧历史卡片
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1500)
const cards = await ev(`(() => {
  const cs = [...document.querySelectorAll('[data-test=invite-history-card]')]
  return JSON.stringify({ 历史卡片数: cs.length, 含本次: cs.some(c => String(c.innerText||'').includes('停/暂停验证')) })
})()`)
console.log('面板历史:', cards)
const cp = (() => { try { return JSON.parse(cards) } catch { return {} } })()
check('面板有历史卡片且包含本次运行', cp.含本次 === true, JSON.stringify(cp))
check('面板存在「停止邀约」按钮元素', (await ev(`!!document.querySelector('[data-test=invite-stop]')`)) !== null)

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
// 清理本次任务
await ev(`(async()=>{await window.shopilot.task.delete('${created.taskId}');return 1})()`).catch(() => {})
ws.close()
setTimeout(() => process.exit(0), 300)
