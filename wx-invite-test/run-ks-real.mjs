/**
 * 快手达人邀约**真实发送**（只跑 1 批）。
 * 用与面板同一份步骤构造生成的 ks-steps-real.json，不替换任何步骤 —— 会真的把邀约发给达人。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
try {
  const { execSync } = await import('child_process')
  execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' })
} catch {}
await sleep(1500)

const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps-real.json', 'utf8'))
steps[0].input.maxRounds = 1
console.log('=== 真实发送（1 批）===')
console.log('步骤数:', steps[0].input.steps.length, '含发送:', steps[0].input.steps.some(x => x.input && x.input.text === '发送邀请'))

const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
await ev("(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (c) c.click(); return 1 })()")
await sleep(3000)
console.log('中栏 viewport:', await ev("(() => { const v = document.querySelector('.viewport, [class*=viewport]'); return v ? Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height) : 'none' })()"))

const payload = { name: '达人邀约 · 快手小店 · 真发1批', storeScope: ks.id, steps }
const payloadJson = JSON.stringify(payload)
const created = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.create(" + payloadJson + "); return JSON.stringify(r) })()"))
console.log('create ok =', created.ok, created.ok ? '' : JSON.stringify(created.error))
if (!created.ok) process.exit(1)
const taskId = created.data.id
const started = JSON.parse(await ev("(async()=>{const r=await window.shopilot.task.run('" + taskId + "');return JSON.stringify(r)})()"))
const runId = started.data && started.data.runId
console.log('runId =', runId)

const t0 = Date.now()
let final = null
for (let i = 0; i < 90; i++) {
  await sleep(4000)
  const st = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.list(); const all = r.ok ? (r.data.tasks || r.data) : []; const t = all.find(x => x.id === '" + taskId + "'); const run = t && t.latestRun; return JSON.stringify({ status: run && run.status, step: run && run.currentStep, code: run && run.errorCode, msg: run && run.errorMessage, runId: run && run.id }) })()"))
  if (i % 3 === 0) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${st.status || '?'} step=${st.step}`)
  if (['succeeded', 'failed', 'cancelled'].includes(st.status)) { final = st; break }
}
console.log('\n=== 结果:', final ? `${final.status} ${final.code || ''}` : '超时', '===')
if (final && final.msg) console.log('错误:', String(final.msg).slice(0, 260))
console.log('TASK_ID=' + taskId, 'RUN_ID=' + (final && final.runId ? final.runId : runId))
ws.close()
setTimeout(() => process.exit(0), 300)
