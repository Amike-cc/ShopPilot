/**
 * 列出当前平台后台页面里**左侧导航的全部菜单文案**（含二级，尝试展开一级菜单），
 * 用于人工判断发票入口在哪。只读浏览，不做资金/发票操作。
 * 用法：node list-platform-menu.mjs <店铺名关键字>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2] || ''

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
const st = stores.find(x => x.name.includes(kw) || x.platform.includes(kw))
if (!st) { console.log('没找到店铺:', kw); process.exit(1) }
console.log(`店铺 ${st.name}（${st.platform}）`)
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(5000)

// 通过 CDP 找到该店铺当前页（用 hostname 精确匹配）
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({u:String(t.url||'')})))})()`))
const host = tabs.map(t => { try { return new URL(t.u).hostname } catch { return '' } }).find(h => h && h !== 'about:blank')
console.log('host:', host)
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
const t = targets.find(x => host && x.url.includes(host))
if (!t) { console.log('没找到平台页面（页面清单:', targets.map(x => x.url.slice(0, 50)), '）'); process.exit(1) }
console.log('页面:', String(t.url).slice(0, 80))

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

console.log('\n=== 页面上全部「发票」相关文本 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const tx = own(el)
    if (!tx || !/发票/.test(tx) || tx.length > 30) continue
    const r = el.getBoundingClientRect()
    out.push({ 文案: tx.slice(0, 24), tag: el.tagName, 可见: r.width > 0 && r.height > 0, 顶层文本: (() => { let n = el; for (let i = 0; i < 3 && n && n.parentElement; i++) n = n.parentElement; return String(n.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) })() })
  }
  const seen = new Set(); const uniq = []
  for (const o of out) { if (seen.has(o.文案)) continue; seen.add(o.文案); uniq.push(o) }
  return JSON.stringify(uniq.slice(0, 20), null, 1)
})()`))

console.log('\n=== 左侧导航（x<230）全部文案 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const tx = own(el)
    if (!tx || tx.length > 12) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (r.left > 230) continue
    out.push(tx)
  }
  return JSON.stringify([...new Set(out)].slice(0, 80))
})()`))
w2.close()
ws.close()
process.exit(0)
