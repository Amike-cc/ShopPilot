/**
 * 深挖某平台后台的「发票」入口：既然是 SPA，先看页面里所有导航链接的 href+文案，
 * 再从结果里筛「发票 / 资金 / 结算」相关；也打印全部顶层菜单文案，便于人工判断该展开哪一项。
 * 用法：node probe-invoice-deep.mjs <店铺名关键字>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2] || '1111'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.name.includes(kw) || x.platform.includes(kw))
if (!st) { console.log('没找到店铺'); process.exit(1) }
console.log(`店铺 ${st.name}（${st.platform}）`)
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
const tabId = tabs[0] || JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${st.id}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
const target = pages.find(x => !x.url.includes('127.0.0.1') && !x.url.includes('out/renderer'))
if (!target) { console.log('没有平台页面'); process.exit(1) }
const w2 = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

console.log('页面:', String(target.url).slice(0, 90))
console.log('\n--- 所有可见顶层菜单文案（前 60） ---')
console.log(await q2(`(() => {
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
    if (r.left > 220) continue  // 只看左侧导航区
    out.push(t)
  }
  return JSON.stringify([...new Set(out)].slice(0, 60))
})()`))

console.log('\n--- 页面内所有链接里含「发票/资金/结算/账单/票据」的 ---')
console.log(await q2(`(() => {
  const out = []
  for (const a of document.querySelectorAll('a')) {
    const t = String(a.innerText || '').trim()
    const href = String(a.getAttribute('href') || '')
    if (!/发票|资金|结算|账单|票据/.test(t + href)) continue
    out.push({ 文案: t.slice(0, 24), href: href.slice(0, 120) })
  }
  return JSON.stringify(out.slice(0, 30), null, 1)
})()`))

console.log('\n--- 导航数据（SPA 常把菜单放 window 变量/脚本里）---')
console.log(await q2(`(() => {
  const hits = []
  try {
    for (const k of Object.keys(window)) {
      if (!/menu|nav|route|config/i.test(k)) continue
      let v
      try { v = window[k] } catch { continue }
      if (!v || typeof v !== 'object') continue
      const str = JSON.stringify(v).slice(0, 4000)
      if (/发票/.test(str)) hits.push({ key: k, snippet: str.slice(str.indexOf('发票') - 160, str.indexOf('发票') + 160) })
    }
  } catch { }
  return JSON.stringify(hits.slice(0, 6), null, 1)
})()`))
w2.close()
ws.close()
setTimeout(() => process.exit(0), 300)
