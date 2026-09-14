/**
 * 抓取平台后台「发票」入口的真实 URL：先尝试点开含发票的菜单项，再读地址栏；
 * 同时把页面里所有 a[href] 中与发票/开票相关的链接列出来。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2] || ''
const CLICK_TEXT = process.argv[3] || ''

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
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(5000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({u:String(t.url||'')})))})()`))
const host = tabs.map(t => { try { return new URL(t.u).hostname } catch { return '' } }).find(h => h && h !== 'about:blank')
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
const t = targets.find(x => host && x.url.includes(host))
if (!t) { console.log('没找到平台页面'); process.exit(1) }
console.log(`店铺 ${st.name}（${st.platform}） 页面 ${String(t.url).slice(0, 70)}`)

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

console.log('\n=== 页面中所有含「发票/开票」的链接 ===')
console.log(await q2(`(() => {
  const out = []
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  for (const el of all) {
    if (el.tagName !== 'A') continue
    const tx = String(el.innerText || '').trim()
    const href = String(el.getAttribute('href') || '')
    if (!/发票|开票/.test(tx + href)) continue
    out.push({ 文案: tx.slice(0, 20), href: href.slice(0, 130) })
  }
  const seen = new Set(); const uniq = []
  for (const o of out) { const k = o.文案 + o.href; if (seen.has(k)) continue; seen.add(k); uniq.push(o) }
  return JSON.stringify(uniq.slice(0, 20), null, 1)
})()`))

if (CLICK_TEXT) {
  console.log(`\n=== 点击「${CLICK_TEXT}」并读取结果 ===`)
  const pt = JSON.parse(await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    for (const el of all) {
      if (own(el) !== ${JSON.stringify(CLICK_TEXT)}) continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    }
    return 'null'
  })()`))
  console.log('坐标:', JSON.stringify(pt))
  if (pt) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await snd('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
      await sleep(80)
    }
    await sleep(6000)
    console.log('点击后 URL:', await q2(`location.href.slice(0, 150)`))
    console.log('页面片段:', await q2(`String(document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0, 200)`))
  }
}
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
