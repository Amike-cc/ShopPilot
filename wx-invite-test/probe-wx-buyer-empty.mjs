/**
 * 复核微信「给买家开票」是否确实为空：切到该方向后等更久，并打印整页文本里与"买家/佣金"相关的片段，
 * 判断是"确实没有记录"还是"我读早了"。
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
await sleep(18000)
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

// 切到「给买家开票」，等 25 秒（懒加载 + 取数）
await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '给买家开票' && e.getBoundingClientRect().width > 0)
  if (!el) return 'no-el'
  let n = el
  for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click() } catch {} }
  return 'clicked'
})()`)
for (const t of [8, 16, 25]) {
  await sleep(t === 8 ? 8000 : 8000)
  console.log(`\n[+${t}s] ${await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const tables = all.filter(e => e.tagName === 'TABLE').map(t => ({ th: [...t.querySelectorAll('th')].map(x=>String(x.innerText||'').trim()).filter(Boolean), n: t.querySelectorAll('tbody tr').length }))
    const dataT = tables.filter(t => t.th.some(h => /账单|金额/.test(h))).sort((a,b)=>b.th.length-a.th.length)[0]
    return JSON.stringify({
      表头: dataT ? dataT.th : [],
      行数: dataT ? dataT.n : 0,
      空状态文案: (txt.match(/(暂无数据|没有数据|暂无待|还没有|去开票|去申请)/g) || []),
      买家相关片段: (txt.match(/.{0,12}买家.{0,20}/g) || []).slice(0, 5)
    })
  })()`)}`)
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
