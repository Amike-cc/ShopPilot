/**
 * 诊断：为什么「点个护家清」成功后，紧接着点「纸品湿巾」就报视图未挂载（0×0）。
 * 列出所有快手标签页及其视口，并观察视图挂载状态在点击前后的变化。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

async function listKs() {
  const l = await J(`http://127.0.0.1:${PORT}/json/list`)
  return l.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
}
async function viewportOf(pg) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  const r = await send('Runtime.evaluate', { expression: `innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState + ' url=' + location.href.slice(0,70)`, returnByValue: true })
  ws.close()
  return r.result?.value
}

console.log('=== 所有快手标签页（含视口）===')
const pgs = await listKs()
for (const p of pgs) {
  let vp = '?'
  try { vp = await viewportOf(p) } catch (e) { vp = 'ERR ' + e.message }
  console.log(`  ${p.id.slice(0,8)}  ${vp}`)
}

console.log('\n=== 渲染层中栏状态 ===')
const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
}
const st = "(() => { if (document.querySelector('.welcome')) return 'welcome'; const vp = document.querySelector('.viewport, [class*=viewport]'); const tabs = [...document.querySelectorAll('[data-test^=tab-item], .tab, [class*=tab-item]')].map(t => String(t.innerText||'').trim()).filter(Boolean).slice(0,8); return JSON.stringify({ vp: vp ? Math.round(vp.getBoundingClientRect().width) + 'x' + Math.round(vp.getBoundingClientRect().height) : null, tabs }) })()"
console.log(await ev(st))
console.log('\n=== 店铺标签页列表（渲染层视角）===')
console.log(await ev(`(async () => {
  const stores = await window.shopilot.store.list()
  const ks = (stores.data||[]).find(x => String(x.platform).includes('快手'))
  if (!ks) return 'no-ks'
  const r = await window.shopilot.browser.tab.list(ks.id)
  const tabs = (r.data && r.data.tabs) || []
  return JSON.stringify(tabs.map(t => ({ id: String(t.id).slice(0,10), active: t.active, url: String(t.url||'').slice(0,70) })), null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
