/**
 * 核实各平台发票页的「开票方向」结构：列出方向级入口（给平台开票/给买家开票/申请平台开票…），
 * 逐个点击并记录落地 URL，用于判断当前抓的是哪个方向、还缺哪些。
 * 只读浏览 + 点导航，不做任何开票提交。
 * 用法：node probe-invoice-directions.mjs <店铺名关键字> <发票页url>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2]
const startUrl = process.argv[3]
if (!kw || !startUrl) { console.log('用法: node probe-invoice-directions.mjs <店铺名> <url>'); process.exit(1) }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.name.includes(kw) || x.platform.includes(kw))
if (!st) { console.log('没找到店铺:', kw); process.exit(1) }
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
// 视口给足高度，避免"点击落在视口外"（上次踩过的坑）
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1500,height:1000});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(startUrl)});return 1})()`)
await sleep(15000)

const host = (() => { try { return new URL(startUrl).hostname } catch { return '' } })()
const wantPath = (() => { try { return new URL(startUrl).pathname } catch { return '' } })()
// 按 host + path 精确挑页面（同域名下常开着多个标签页，取最后一个会连错）
const pg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  .filter(x => x.type === 'page' && x.url.includes(host) && x.url.includes(wantPath)).pop()
if (!pg) { console.log('页面没出来（按', wantPath, '找）'); process.exit(1) }
console.log(`店铺 ${st.name}（${st.platform}） 起始页 ${String(pg.url).slice(0, 100)}`)
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const DIR_RE = '给平台开票|给买家开票|给消费者开票|申请平台开票|平台给我开票|我给平台开票|给平台开具|收佣金发票|达人给我开票|开票给|发票管理|订单开票'

console.log('\n=== 页面上的「方向级」入口 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/${DIR_RE}/.test(t) || t.length > 20) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const a = el.closest('a')
    out.push({ 文案: t, tag: el.tagName, 位置: [Math.round(r.left), Math.round(r.top)], href: a ? String(a.getAttribute('href') || '') : null })
  }
  const seen = new Set(); const uniq = []
  for (const o of out) { const k = o.文案 + o.位置[1]; if (seen.has(k)) continue; seen.add(k); uniq.push(o) }
  return JSON.stringify(uniq.slice(0, 20), null, 1)
})()`))

console.log('\n=== 逐个点击方向入口，记录 URL ===')
const items = JSON.parse(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/${DIR_RE}/.test(t) || t.length > 20) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push({ t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  return JSON.stringify(out)
})()`))
const clicked = new Set()
for (const it of items) {
  if (clicked.has(it.t)) continue
  clicked.add(it.t)
  const before = await q2('location.href')
  await snd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: it.x, y: it.y })
  await sleep(500)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: it.x, y: it.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(90)
  }
  await sleep(6500)
  const after = await q2('location.href')
  const changed = before !== after
  // 读一下表格表头，确认这个方向的表结构
  const ths = await q2(`(() => { const all=[]; const walk=(r)=>{for(const el of r.querySelectorAll('*')){all.push(el);if(el.shadowRoot)walk(el.shadowRoot)}}; walk(document); const tables=all.filter(e=>e.tagName==='TABLE'); const t=tables.map(x=>[...x.querySelectorAll('th')].map(y=>String(y.innerText||'').trim()).filter(Boolean)).sort((a,b)=>b.length-a.length)[0]||[]; return JSON.stringify(t.slice(0,12)) })()`)
  console.log(`「${it.t}」 → ${changed ? 'URL 变了' : 'URL 未变'}  ${String(after).slice(0, 100)}`)
  console.log(`     表头: ${ths}`)
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
