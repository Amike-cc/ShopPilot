/**
 * 探快手的发票入口：① 悬停/点击「资金」看子菜单 ② 逐个尝试候选 URL 看是否真实渲染发票页
 * 只读浏览，不做任何资金/发票提交操作。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const KW = process.argv[2] || '福气满满'

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
const st = stores.find(x => x.name.includes(KW) || x.platform.includes(KW))
if (!st) { console.log('没找到店铺'); process.exit(1) }
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(5000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
const host = tabs.map(t => { try { return new URL(t.u).hostname } catch { return '' } }).find(h => h && h !== 'about:blank')
console.log(`店铺 ${st.name}（${st.platform}） host=${host} tab=${tabId}`)

// 找到该店铺的页面（用 CDP 直接读内容）
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
const t = targets.find(x => host && x.url.includes(host))
if (!t) { console.log('没找到平台页面'); process.exit(1) }
const w2 = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200)
  return r.result?.value
}

// ① 悬停「资金」
const pt = JSON.parse(await q2(`(() => {
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
console.log('「资金」坐标:', JSON.stringify(pt))
if (pt) {
  await snd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  await sleep(2500)
  console.log('悬停后的菜单文案:', await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const out = []
    for (const el of all) {
      const tx = own(el)
      if (!tx || tx.length > 14) continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      if (r.left > 300) continue
      out.push(tx)
    }
    return JSON.stringify([...new Set(out)].slice(0, 70))
  })()`))
  // 点击「资金」
  for (const type of ['mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(90)
  }
  await sleep(3500)
  console.log('点击后 URL:', await q2(`location.href.slice(0, 120)`))
  console.log('点击后可见文本（含发票？）:', await q2(`(() => { const t = String(document.body?document.body.innerText:'').replace(/\\s+/g,' '); return JSON.stringify({ 含发票: /发票/.test(t), 片段: t.slice(0, 220) }) })()`))
}
w2.close()

// ② 逐个试候选 URL（在运行标签页里导航，看是否真实渲染发票页）
const candidates = [
  'https://s.kwaixiaodian.com/fund/invoice',
  'https://s.kwaixiaodian.com/finance/invoice',
  'https://s.kwaixiaodian.com/invoice/list',
  'https://s.kwaixiaodian.com/zone/invoice',
  'https://s.kwaixiaodian.com/fund/invoice/list'
]
console.log('\n=== 候选地址探测 ===')
for (const url of candidates) {
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(url)});return 1})()`)
  await sleep(7000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes(host))
  const pg = pages[pages.length - 1]
  if (!pg) { console.log(`${url} → 页面丢失`); continue }
  const w3 = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w3.onopen = ok; w3.onerror = err })
  let s3 = 0; const p3 = new Map()
  w3.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p3.has(m.id)) { p3.get(m.id)(m); p3.delete(m.id) } }
  const snd3 = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s3; p3.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w3.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q3 = async (expr) => (await snd3('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  console.log(`${url}\n   → ${await q3(`(() => { const t = String(document.body?document.body.innerText:'').replace(/\\s+/g,' '); return JSON.stringify({ finalUrl: location.href.slice(0,90), 含发票: /发票/.test(t), 是404: /404|页面不存在|找不到页面/.test(t), 片段: t.slice(0,120) }) })()`)}`)
  w3.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
