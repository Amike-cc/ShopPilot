/**
 * 快手达人邀约真机实跑（用真实任务引擎，走面板同一份步骤构造）。
 *
 * 用法：
 *   node run-ks-invite.mjs            → 彩排：不点「发送邀请」（把该步换成截图）
 *   node run-ks-invite.mjs --real     → 真发：含真实「发送邀请」，但**只跑 1 批**
 *
 * 关键：脚本本身不做任何"挂载视图/激活标签页"的操作——那是引擎的职责
 * （每轮开头 activateTab）。之前我自己的探针没激活标签页，导致视口 0×0、
 * 所有几何测量失真，白折腾了几轮。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const REAL = process.argv.includes('--real')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

// 恢复窗口（最小化时 Chromium 会把原生视图尺寸归零）
try {
  const { execSync } = await import('child_process')
  execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' })
} catch { /* 不是致命问题 */ }
await sleep(1500)

const steps = JSON.parse(fs.readFileSync(process.env.KS_STEPS_FILE || 'wx-invite-test/ks-steps.json', 'utf8'))
const loop = steps[0]
const inner = loop.input.steps
if (!REAL) {
  const i = inner.findIndex(x => x.type === 'clickByText' && x.input && x.input.text === '发送邀请')
  if (i >= 0) {
    inner.splice(i, 1)
    const g = inner.findIndex(x => x.type === 'waitForGone' && String(x.input.selector) === 'textarea')
    if (g >= 0) inner.splice(g, 1)
    inner.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
  }
  // 探针序列可能本来就没有「发送邀请」（只跑到商品弹窗为止）→ 那就照原样跑
}
loop.input.maxRounds = 1
loop.input.stopOn = ['TASK_DAREN_PAGE_UNOPENABLE']
console.log(REAL ? '=== 真发模式（只 1 批）===' : '=== 彩排模式（不发送）===')
console.log('步骤数:', inner.length, '含发送:', inner.some(x => x.input && x.input.text === '发送邀请'))

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
// 打开店铺并**在渲染层点店铺卡**（用户正常操作；引擎依赖中栏视口尺寸）
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
await ev("(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (c) c.click(); return 1 })()")
await sleep(3000)
console.log('中栏 viewport:', await ev("(() => { const v = document.querySelector('.viewport, [class*=viewport]'); return v ? Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height) : 'none' })()"))

const payload = { name: (REAL ? '达人邀约 · 快手小店 · 真发1批' : '达人邀约 · 快手小店 · 彩排'), storeScope: ks.id, steps }
const payloadJson = JSON.stringify(payload)
const created = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.create(" + payloadJson + "); return JSON.stringify(r) })()"))
console.log('create ok =', created.ok, created.ok ? '' : JSON.stringify(created.error))
if (!created.ok) process.exit(1)
const taskId = created.data.id
const started = JSON.parse(await ev("(async()=>{const r=await window.shopilot.task.run('" + taskId + "');return JSON.stringify(r)})()"))
const runId = started.ok && started.data ? started.data.runId : null
console.log('runId =', runId)

const t0 = Date.now()
let final = null
for (let i = 0; i < 200; i++) {
  await sleep(4000)
  const st = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.list(); const all = r.ok ? (r.data.tasks || r.data) : []; const t = all.find(x => x.id === '" + taskId + "'); const run = t && t.latestRun; return JSON.stringify({ status: run && run.status, step: run && run.currentStep, code: run && run.errorCode, msg: run && run.errorMessage, runId: run && run.id }) })()"))
  if (i % 3 === 0) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${st.status || '?'} step=${st.step}`)
  if (['succeeded', 'failed', 'cancelled'].includes(st.status)) { final = st; break }
}
console.log('\n=== 结果:', final ? `${final.status} ${final.code || ''}` : '超时未结束', '===')
if (final && final.msg) console.log('错误信息:', String(final.msg).slice(0, 300))
console.log('\n步骤结果:')
console.log(String(await ev("(async () => { const r = await window.shopilot.task.results(" + JSON.stringify(final && final.runId ? final.runId : '') + "); return JSON.stringify(r.data, null, 1) })()")).slice(0, 3000))
ws.close()
setTimeout(() => process.exit(0), 300)
