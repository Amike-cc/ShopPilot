/**
 * 微信发票中心：逐个方向 tab（申请平台开票/给买家开票/给平台开票/收佣金发票）
 * 点击后**等页面重渲染**，把每个方向下的汇总数字、表头、前两行数据都读出来对比。
 * 只读，不做任何开票操作。
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
const pg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  .filter(x => x.type === 'page' && x.url.includes('bill/home')).pop()
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
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const tables = all.filter(e => e.tagName === 'TABLE')
  const dataT = tables.find(t => /账单号|订单号|账单编号/.test(String(t.innerText||'')))
  const ths = dataT ? [...dataT.querySelectorAll('th')].map(x => String(x.innerText||'').trim()).filter(Boolean) : []
  const rows = dataT ? [...dataT.querySelectorAll('tbody tr')].slice(0, 2).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 24))) : []
  const rowCount = dataT ? dataT.querySelectorAll('tbody tr').length : 0
  // 汇总块：找「可开票 / 已开票」这类标签与金额
  const money = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 30) continue
    if (/^[¥￥][\\d,]+\\.?\\d*$/.test(t) || /^(可开票|已开票|待开票|未开票|已申请|已完成)$/.test(t)) money.push(t)
  }
  return JSON.stringify({ 表头: ths, 行数: rowCount, 前两行: rows, 关键数字: [...new Set(money)].slice(0, 10) })
})()`

async function clickTab(label) {
  const pt = JSON.parse(await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const cands = all.filter(el => own(el) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0)
    if (!cands.length) return 'null'
    // 取最靠上的那个（顶部方向 tab 在 y≈167；同名元素可能在别处）
    cands.sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    const el = cands[0]
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), 候选数: cands.length })
  })()`))
  if (!pt) return null
  await snd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  await sleep(400)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(100)
  }
  // 等页内切换 + 重新取数
  await sleep(9000)
  return pt
}

for (const dir of ['申请平台开票', '给买家开票', '给平台开票', '收佣金发票']) {
  const pt = await clickTab(dir)
  console.log(`\n===== 「${dir}」 =====`)
  console.log('  点击:', JSON.stringify(pt))
  console.log('  ' + await q2(SNAP))
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
