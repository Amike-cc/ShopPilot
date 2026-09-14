/**
 * 查微信发票中心顶部 4 个方向入口的真实 DOM：它们是 tab（A/li）还是普通 span？
 * 选中态挂在谁身上？用 JS 直接点击对比（排除"受信任鼠标点错元素"的可能）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
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
const st = stores.find(x => x.platform.includes('微信'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1500,height:1000});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://store.weixin.qq.com/shop/bill/home');return 1})()`)
await sleep(17000)
const pg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('bill/home')).pop()
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 220) : r.result?.value
}

console.log('=== 4 个方向入口的 DOM 结构 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const label of ['申请平台开票', '给买家开票', '给平台开票', '收佣金发票']) {
    for (const el of all) {
      if (own(el) !== label) continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const chain = []
      let n = el
      for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
        chain.push(n.tagName + (n.className ? '.' + String(n.className).replace(/\\s+/g,'.').slice(0,60) : ''))
      }
      out.push({ label, 链: chain, y: Math.round(r.top), cls: String(el.className||'').slice(0,50), 父cls: String((el.parentElement&&el.parentElement.className)||'').slice(0,60) })
      break
    }
  }
  return JSON.stringify(out, null, 1)
})()`))

console.log('\n=== 用 JS 依次点击（el.click() + 祖先），对比表格首行 ===')
for (const label of ['给买家开票', '给平台开票', '收佣金发票', '申请平台开票']) {
  const r = await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const cands = all.filter(el => own(el) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0)
    if (!cands.length) return 'no-el'
    const el = cands[0]
    // 依次点自身与 3 层祖先（微应用里常把 onClick 挂在 li/div 上）
    const clicked = []
    let n = el
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); clicked.push(n.tagName) } catch (e) { clicked.push('err') } }
    return JSON.stringify(clicked)
  })()`)
  await sleep(7000)
  const snap = await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const t = all.filter(e => e.tagName === 'TABLE').map(x => [...x.innerText.split('\\n')].slice(0,4)).sort((a,b)=>b.length-a.length)[0] || []
    const txt = String(document.body?document.body.innerText:'').replace(/\\s+/g,' ')
    return JSON.stringify({ 表头区: t.slice(0,2), 含给买家: /给买家开票/.test(txt) })
  })()`)
  console.log(`「${label}」 JS点击=${r}`)
  console.log(`   ${snap}`)
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
