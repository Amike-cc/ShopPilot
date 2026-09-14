/**
 * 列出快手后台（生意通 syt.kwaixiaodian.com）页面上**所有真实导航链接**，
 * 从中找发票/资金相关入口。只读浏览。
 */
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.platform.includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
await sleep(1000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id

// 用「资金」的真实落地页：从后台首页点「资金」，看落到哪
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://s.kwaixiaodian.com/zone/home');return 1})()`)
await sleep(14000)
let pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
let pg = pages[pages.length - 1]
async function connect(p) {
  const w = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
  let s2 = 0; const q = new Map()
  w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; q.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
  return { q: async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, snd, close: () => w.close() }
}
let c = await connect(pg)

console.log('=== 全部 a[href]（去重，前 60）===')
console.log(await c.q(`(() => {
  const out = []
  for (const a of document.querySelectorAll('a')) {
    const href = String(a.getAttribute('href') || '')
    const t = String(a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 18)
    if (!href || href === '#') continue
    out.push(t ? (t + ' → ' + href) : href)
  }
  return JSON.stringify([...new Set(out)].slice(0, 60), null, 1)
})()`))

console.log('\n=== 点「资金」看落地页 ===')
const pt = JSON.parse(await c.q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  for (const el of all) {
    if (own(el) !== '资金') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  return 'null'
})()`))
if (pt) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(90)
  }
  await sleep(11000)
  console.log('落地 URL:', await c.q(`location.href.slice(0, 120)`))
  console.log('页内链接（含发票/资金/结算）:', await c.q(`(() => {
    const out = []
    for (const a of document.querySelectorAll('a')) {
      const href = String(a.getAttribute('href') || '')
      const t = String(a.innerText || '').replace(/\\s+/g,' ').trim()
      if (!/发票|资金|结算|账户|invoice/i.test(t + href)) continue
      out.push(t.slice(0,16) + ' → ' + href.slice(0,80))
    }
    return JSON.stringify([...new Set(out)].slice(0, 30), null, 1)
  })()`))
}
c.close(); ws.close()
setTimeout(() => process.exit(0), 300)
