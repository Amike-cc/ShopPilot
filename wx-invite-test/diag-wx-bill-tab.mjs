/** 诊断微信发票：点「可开票」页签的行为 + 点完后表格是否还在 */
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
await sleep(4000)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
await sleep(1000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://store.weixin.qq.com/shop/bill/home');return 1})()`)
await sleep(16000)
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('bill/home'))
const pg = pages[pages.length - 1]
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const SNAP = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const tables = all.filter(el => el.tagName === 'TABLE')
  const dataT = tables.find(t => String(t.innerText||'').includes('账单号'))
  // 页签状态
  const tabState = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/^(可开票|已开票|开票记录)$/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const cls = String(el.className||'') + ' | ' + String((el.parentElement&&el.parentElement.className)||'')
    tabState.push({ t, 选中: /(current|active|selected)/i.test(cls), tag: el.tagName, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
  }
  return JSON.stringify({
    table数: tables.length,
    数据表行数: dataT ? dataT.querySelectorAll('tr').length : 0,
    页签: tabState
  }, null, 1)
})()`

console.log('初始状态:', await q2(SNAP))

// 找到「可开票」坐标，真实点击
const pt = JSON.parse(await q2(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // 优先取带 weui-desktop-tab__nav 的那个（真正的页签）
  const cands = all.filter(el => own(el) === '可开票' && el.getBoundingClientRect().width > 0)
  const best = cands.find(el => /weui-desktop-tab__nav/.test(String(el.className||'') + String((el.parentElement&&el.parentElement.className)||''))) || cands[0]
  if (!best) return 'null'
  const r = best.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: best.tagName, 候选数: cands.length, cls: String(best.className||'').slice(0,50) })
})()`))
console.log('可开票坐标:', JSON.stringify(pt))
if (pt) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(90)
  }
  await sleep(7000)
  console.log('点击后状态:', await q2(SNAP))
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
