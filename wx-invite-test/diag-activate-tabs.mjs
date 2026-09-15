/**
 * 逐个激活快手店铺的标签页，测量它是否被真正挂载（视口 > 0）。
 * 用途：搞清"任务运行时那个 tab 到底有没有被挂载"。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

async function allKsViewports() {
  const l = await J(`http://127.0.0.1:${PORT}/json/list`)
  const out = {}
  for (const p of l.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))) {
    try {
      const w = new WebSocket(p.webSocketDebuggerUrl)
      await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
      let s = 0; const pend = new Map()
      w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error('x')) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: `innerWidth+'x'+innerHeight+'@'+location.href.slice(-30)`, returnByValue: true })
      out[String(p.id).slice(0, 6)] = r.result?.value || '?'
      w.close()
    } catch { out[String(p.id).slice(0, 6)] = 'ERR' }
  }
  return out
}

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
console.log('初始各页视口:', JSON.stringify(await allKsViewports(), null, 1))

const tabs = JSON.parse(await ev("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, active: !!x.active, u: String(x.url||'').slice(-45) }))) })()"))
console.log('\n店铺标签页:')
for (const t of tabs) console.log('  ', t.id, t.active ? '[active]' : '        ', t.u)

console.log('\n=== 逐个激活并测量 ===')
console.log('browser.tab API:', await ev(`Object.keys(window.shopilot.browser.tab).join(',')`))
for (const t of tabs) {
  const r = await ev("(async () => { try { const fn = window.shopilot.browser.tab.activate || window.shopilot.browser.tab.select; if (!fn) return 'no-activate-api'; const res = await fn(" + JSON.stringify(ks.id) + ", " + JSON.stringify(t.id) + "); return JSON.stringify(res) } catch (e) { return 'ERR ' + e.message } })()")
  await sleep(2200)
  const vps = await allKsViewports()
  const live = Object.entries(vps).filter(([, v]) => !String(v).startsWith('0x0')).map(([k, v]) => k + '=' + v)
  console.log(`  激活 ${t.id} → ${String(r).slice(0, 80)} | 非零视口: ${live.length ? live.join(' ') : '(全为 0×0)'}`)
}
ws.close()
setTimeout(() => process.exit(0), 200)
