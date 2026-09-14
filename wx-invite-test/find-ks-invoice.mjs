/**
 * 认真找快手小店的发票入口（上次失败原因：点「资金」的坐标 y=1186 在 900px 视口之外，点击没落地）。
 * 这次：先把左侧导航滚进视口 → 真实点击「资金」→ dump 展开后的子菜单与所有链接 → 再搜发票字样。
 * 只读浏览，不做任何资金/开票操作。
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
const st = stores.find(x => x.platform.includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1500,height:1000});return 1})()`)
await sleep(1500)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://s.kwaixiaodian.com/zone/home');return 1})()`)
await sleep(16000)

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
const pg = pages[pages.length - 1]
if (!pg) { console.log('快手页面没出来'); process.exit(1) }
console.log('页面:', String(pg.url).slice(0, 90))
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const ALL_LINKS = `(() => {
  const out = []
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  for (const el of all) {
    if (el.tagName !== 'A') continue
    const href = String(el.getAttribute('href') || '')
    if (!href || href === '#' || href === 'javascript:void(0)') continue
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20)
    out.push(t ? (t + ' → ' + href) : href)
  }
  return JSON.stringify([...new Set(out)].slice(0, 80), null, 1)
})()`

console.log('\n=== 全部 a[href]（前 80）===')
console.log(await q2(ALL_LINKS))

console.log('\n=== 整页搜「发票」===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/发票|开票|票据/.test(t) || t.length > 30) continue
    const r = el.getBoundingClientRect()
    const a = el.closest('a')
    hits.push({ 文案: t.slice(0, 24), 可见: r.width > 0 && r.height > 0, tag: el.tagName, href: a ? String(a.getAttribute('href') || '') : null, 位置: [Math.round(r.left), Math.round(r.top)] })
  }
  const seen = new Set(); const uniq = []
  for (const h of hits) { const k = h.文案 + h.href; if (seen.has(k)) continue; seen.add(k); uniq.push(h) }
  return JSON.stringify(uniq.slice(0, 25), null, 1)
})()`))

// 把左侧导航滚到底，找「资金」并点击
console.log('\n=== 滚动左侧导航找「资金」并点击 ===')
const pt = JSON.parse(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => own(el) === '资金')
  if (!cands.length) return 'null'
  const el = cands[0]
  // 滚进视口
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 候选数: cands.length, tag: el.tagName })
})()`))
console.log('资金坐标:', JSON.stringify(pt))
if (pt) {
  await snd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  await sleep(1200)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(100)
  }
  await sleep(6000)
  console.log('点击后 URL:', await q2(`location.href.slice(0, 130)`))
  console.log('点击后菜单项（左侧）:', await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const out = []
    for (const el of all) {
      const t = own(el)
      if (!t || t.length > 14) continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      if (r.left > 260) continue
      out.push(t)
    }
    return JSON.stringify([...new Set(out)].slice(0, 80))
  })()`))
  console.log('点击后含发票:', await q2(`(() => { const t = String(document.body?document.body.innerText:''); return JSON.stringify({ 含发票: /发票/.test(t), 片段: (t.replace(/\\s+/g,' ').match(/(发票|开票)[^ ]{0,20}/) || [null])[0] }) })()`))
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
