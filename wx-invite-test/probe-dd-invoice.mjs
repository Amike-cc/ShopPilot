/**
 * 在抖店后台里找「发票」入口：列出所有含发票的元素 + href，并尝试点开看真实地址。
 * 只读浏览，不做任何开票操作。
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.platform.includes('抖店'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://fxg.jinritemai.com/ffa/mshop/homepage/index');return 1})()`)
await sleep(14000)

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('jinritemai'))
const pg = pages[pages.length - 1]
if (!pg) { console.log('页面没出来'); process.exit(1) }
console.log('页面:', String(pg.url).slice(0, 100))
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250)
  return r.result?.value
}

console.log('\n=== 是否已登录 ===')
console.log(await q2(`(() => { const t = String(document.body?document.body.innerText:'').replace(/\\s+/g,' '); return JSON.stringify({ 有后台特征: /店铺管理|商品管理|订单管理|账户中心/.test(t), 是营销页: /0保证金创业|开店阶段/.test(t), 片段: t.slice(0, 120) }) })()`))

console.log('\n=== 含「发票」的元素与链接 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/发票/.test(t) || t.length > 24) continue
    const r = el.getBoundingClientRect()
    const a = el.closest('a')
    out.push({ t: t.slice(0, 20), tag: el.tagName, href: a ? String(a.getAttribute('href') || '') : null, 可见: r.width > 0 && r.height > 0 })
  }
  const seen = new Set(); const uniq = []
  for (const o of out) { const k = o.t + o.href; if (seen.has(k)) continue; seen.add(k); uniq.push(o) }
  return JSON.stringify(uniq.slice(0, 25), null, 1)
})()`))

console.log('\n=== 页面所有 a[href] 里含 invoice/fapiao/发票 的 ===')
console.log(await q2(`(() => {
  const out = []
  for (const a of document.querySelectorAll('a')) {
    const href = String(a.getAttribute('href') || '')
    const t = String(a.innerText || '').replace(/\\s+/g, ' ').trim()
    if (!/invoice|fapiao|发票/i.test(href + t)) continue
    out.push({ t: t.slice(0, 20), href: href.slice(0, 130) })
  }
  return JSON.stringify([...new Set(out.map(o => JSON.stringify(o)))].map(x => JSON.parse(x)).slice(0, 20), null, 1)
})()`))

console.log('\n=== 左侧导航含「账户/资金/发票」的项 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 12) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (!/账户|资金|发票|财务/.test(t)) continue
    out.push(t)
  }
  return JSON.stringify([...new Set(out)].slice(0, 30))
})()`))
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
