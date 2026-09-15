/**
 * 时间线诊断：跑一个小任务（navigate + waitForPage + readText），
 * 期间每 700ms 采样：各快手标签页的视口、渲染层 .viewport 尺寸、店铺标签页列表。
 * 目的是看清"视图什么时候变成 0×0、是哪个标签页被挂载"。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
await ev("(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (c) c.click(); return 1 })()")
await sleep(3500)

async function sample(label) {
  const tabs = JSON.parse(await ev("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: String(x.id).slice(0,6), act: x.active, u: String(x.url||'').slice(-40) }))) })()"))
  const vp = await ev("(() => { const v = document.querySelector('.viewport, [class*=viewport]'); return v ? Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height) : 'none' })()")
  // 各 page target 的视口
  const l = await J(`http://127.0.0.1:${PORT}/json/list`)
  const ksPages = l.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
  const sizes = []
  for (const p of ksPages) {
    try {
      const w = new WebSocket(p.webSocketDebuggerUrl)
      await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
      let s2 = 0; const p2 = new Map()
      w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
      const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error('x')) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
      const r = await snd('Runtime.evaluate', { expression: `innerWidth+'x'+innerHeight`, returnByValue: true })
      sizes.push(String(p.id).slice(0, 6) + '=' + (r.result?.value || '?'))
      w.close()
    } catch { sizes.push(String(p.id).slice(0, 6) + '=ERR') }
  }
  console.log(`[${label}] 渲染层.viewport=${vp} | 标签页=${JSON.stringify(tabs)} | 各页视口=${sizes.join(' ')}`)
}

await sample('起始')

// 最小任务：navigate + waitForPage + readText + screenshot（不点任何东西）
const steps = [
  { type: 'navigate', input: { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'daren-square-pro' }, timeoutMs: 45000 },
  { type: 'waitMs', input: { ms: 6000 } },
  { type: 'readText', input: { selector: 'body', metric: 'probe.bodyLen' }, timeoutMs: 20000 }
]
const payload = { name: '时间线探针 · 快手', storeScope: ks.id, steps }
const payloadJson = JSON.stringify(payload)
const created = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.create(" + payloadJson + "); return JSON.stringify(r) })()"))
console.log('create ok=', created.ok, created.error ? created.error.message : '')
if (!created.ok) process.exit(1)
const taskId = created.data.id
await ev("(async()=>{const r=await window.shopilot.task.run('" + taskId + "');return JSON.stringify(r)})()")

for (let i = 1; i <= 12; i++) {
  await sleep(1400)
  await sample('t+' + i)
  const st = JSON.parse(await ev("(async () => { const r = await window.shopilot.task.list(); const all = r.ok ? (r.data.tasks || r.data) : []; const t = all.find(x => x.id === '" + taskId + "'); const run = t && t.latestRun; return JSON.stringify({ status: run && run.status, step: run && run.currentStep, code: run && run.errorCode, msg: run && run.errorMessage }) })()"))
  if (['succeeded','failed','cancelled'].includes(st.status)) {
    console.log(`\n任务结束: ${st.status} ${st.code || ''} ${st.msg ? '— ' + String(st.msg).slice(0,200) : ''}`)
    break
  }
}
ws.close()
setTimeout(() => process.exit(0), 300)
