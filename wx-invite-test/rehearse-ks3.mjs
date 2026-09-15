/**
 * 快手邀约「发送前彩排」：把 ks-steps.json（由面板同一份构造逻辑生成）提交给**真实任务引擎**执行，
 * 只把最后一步「发送邀请」换成截图（waitForGone 一并去掉），maxRounds=1。
 *
 * 为什么：邀请会真实发出（不可撤回），未获授权不点发送。
 * 其余每一步都是真页面/真点击/真输入：类目级联 + 内容标签 + 合作信息 → 搜索 →
 * 逐个勾选（minSelect=2 下限）→ 批量邀约开抽屉 → 额度预检 → 联系方式/话术 →
 * 商品弹窗选择 → 合作标签。跑完如实打印每步结果并截图留证。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result?.value
}

const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps.json', 'utf8'))
const loop = steps[0]
const inner = loop.input.steps
// REAL_SEND=1：不替换发送步骤，只把 maxRounds 压到 1（**只发一批**，避免把当天额度打满），
// 用于验证"真实发送"这条路真的通。默认（彩排）把发送换成截图。
const REAL_SEND = process.env.KS_REAL_SEND === '1'
if (!REAL_SEND) {
  const sendIdx = inner.findIndex(x => x.type === 'clickByText' && x.input && x.input.text === '发送邀请')
  if (sendIdx < 0) { console.log('步骤里没有「发送邀请」'); process.exit(1) }
  inner.splice(sendIdx, 1)
  const goneIdx = inner.findIndex(x => x.type === 'waitForGone')
  if (goneIdx >= 0) inner.splice(goneIdx, 1)
  inner.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
} else {
  console.log('*** 真实发送模式：会真的把邀约发给达人（只发一批）***')
}
loop.input.maxRounds = 1
// stopOn 不能置空（schema 要求 min(1)）。用一个彩排里**不会出现**的错误码占位，
// 否则真出问题时会被当成"按预期收工"，把失败误读成成功（实测踩过）。
loop.input.stopOn = ['TASK_DAREN_PAGE_UNOPENABLE']
console.log('步骤数:', inner.length, REAL_SEND ? '（含真实「发送邀请」）' : '（「发送邀请」已替换为截图）')

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
// 关键：还要**在渲染层点一下店铺卡**。只调 browser.display 时渲染层仍停在欢迎页，
// 中栏没有 viewport → 视图 bounds 保持 0×0 → 需要真实落点的步骤会如实报 TASK_VIEW_DETACHED
// （实测踩到）。点店铺卡=用户正常选店，渲染层才有 viewport 上报。
const clickCardExpr = "(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (!c) return 'no-card'; c.click(); return 'clicked' })()"
console.log('点店铺卡:', await ev(clickCardExpr))
await sleep(3500)
const stateExpr = "(() => { if (document.querySelector('.welcome')) return 'welcome'; const vp = document.querySelector('.viewport, [class*=viewport]'); return vp ? 'viewport ' + Math.round(vp.getBoundingClientRect().width) + 'x' + Math.round(vp.getBoundingClientRect().height) : 'unknown' })()"
console.log('中栏是否已挂载店铺视图:', await ev(stateExpr))

const payload = { name: '邀约彩排 · 快手小店（不发送）', storeScope: ks.id, steps }
// 步骤 JSON 走**文件**传递：直接内联进表达式时，中文/布尔在字符串拼接里容易被转义搞坏
// （实测第一次就踩到：创建被拒 "Array must contain at least 1 element(s)"，其实是 payload 没传对）
const payloadJson = JSON.stringify(payload)
fs.writeFileSync('wx-invite-test/ks-rehearsal-payload.json', payloadJson, 'utf8')
console.log('payload 长度:', payloadJson.length, 'steps[0].input.steps 长度:', steps[0].input.steps.length)

console.log('\n=== 创建彩排任务 ===')
const created = JSON.parse(await ev(`(async () => {
  const payload = ${JSON.stringify(payloadJson)}
  const r = await window.shopilot.task.create(JSON.parse(payload))
  return JSON.stringify(r)
})()`))
console.log('create:', JSON.stringify(created).slice(0, 400))
if (!created.ok) { console.log('创建失败，终止'); process.exit(1) }
const taskId = created.data.id || created.data.taskId

console.log('\n=== 运行（真实执行到发送前一步）===')
const started = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.task.run('${taskId}');return JSON.stringify(r)})()`))
console.log('run:', JSON.stringify(started).slice(0, 200))
const runId = started.ok && started.data ? started.data.runId : null

// 等跑完（最多 8 分钟）
const t0 = Date.now()
let final = null
for (let i = 0; i < 160; i++) {
  await sleep(4000)
  const st = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = r.ok ? (r.data.tasks || r.data) : []
    const t = all.find(x => x.id === '${taskId}')
    if (!t || !t.latestRun) return JSON.stringify({ none: true })
    const run = t.latestRun
    return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage, runId: run.id, currentStep: run.currentStep })
  })()`))
  if (i % 4 === 0) console.log(`  [${Math.round((Date.now()-t0)/1000)}s] ${st.status || '?'} step=${st.currentStep}`)
  if (['succeeded','failed','cancelled'].includes(st.status)) { final = st; break }
}
console.log('\n=== 彩排结果:', final ? `${final.status} ${final.code || ''} ${final.msg ? '— ' + String(final.msg).slice(0, 220) : ''}` : '未在时限内结束', '===')

// 逐步骤结果（用 task.detail 或 runDetail）
const detail = await ev(`(async () => {
  try {
    if (window.shopilot.task.detail) { const r = await window.shopilot.task.detail('${taskId}'); return JSON.stringify(r.data).slice(0, 6000) }
    if (window.shopilot.task.runDetail) { const r = await window.shopilot.task.runDetail('${final && final.runId ? final.runId : ''}'); return JSON.stringify(r.data).slice(0, 6000) }
  } catch (e) { return 'ERR ' + e.message }
  return '(无 detail API)'
})()`)
console.log('\n任务详情（截断）:\n' + String(detail).slice(0, 4000))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-rehearsal.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-rehearsal.png')
console.log('TASK_ID=' + taskId)
ws.close()
setTimeout(() => process.exit(0), 300)
