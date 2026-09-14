/**
 * 对比：在**由 window.open 新开的详情标签页**上点「邀请带货」，
 * CDP Input 能跳转、而引擎的 wc.sendInputEvent 不跳转？——顺带看该标签页的挂载/激活状态。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function pick(urlPart, budgetMs = 40000, exactPath = null) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
      if (exactPath) {
        let pn = ''
        try { pn = new URL(t.url).pathname } catch { continue }
        if (pn !== exactPath) continue
      }
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
      let s = 0
      const pend = new Map()
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) return { url: t.url, send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1000)
  }
}
const BTN = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  for (const el of all) {
    if (own(el) !== '邀请带货') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    return JSON.stringify({ rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], point: [x, y], hitSelf: at === el || el.contains(at), topmost: at ? at.tagName + '.' + String(at.className || '').slice(0, 30) : null, url: location.href.slice(0, 70) })
  }
  return 'null'
})()`

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,60)}))})})()`)
const p = JSON.parse(raw)
console.log('店铺标签页:', JSON.stringify(p, null, 1))

// 用引擎同样的机制：从广场点第一个「详情」（这里用 CDP 代替，等价的新标签页来源）
const sq = await pick('/findersquare/find', 40000, '/shop/findersquare/find')
if (!sq) { console.log('没有广场页'); process.exit(1) }
console.log('广场:', sq.url.slice(0, 70), 'w=', await sq.ev('window.innerWidth'))
const before = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page').map(t => t.url)
const dp = JSON.parse(await sq.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  for (const el of all) { if (own(el) !== '详情') continue
    const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0 && r.top > 120 && r.bottom < innerHeight)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    if (at === el || el.contains(at)) return JSON.stringify([x, y])
  }
  return 'null'
})()`))
if (!dp) { console.log('广场上找不到未被遮挡的「详情」'); process.exit(1) }
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await sq.send('Input.dispatchMouseEvent', { type, x: dp[0], y: dp[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(70)
}
await sleep(4000)
const det = await pick('finder-detail', 25000)
if (!det) { console.log('详情页没开出来'); process.exit(1) }
console.log('详情页:', det.url.slice(0, 80), 'w=', await det.ev('window.innerWidth'))
await sleep(2500)
const b = JSON.parse(await det.ev(BTN))
console.log('按钮:', JSON.stringify(b))
// CDP 点击（trusted）
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await det.send('Input.dispatchMouseEvent', { type, x: b.point[0], y: b.point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(80)
}
await sleep(4000)
console.log('CDP 点击后 URL:', await det.ev('location.href.slice(0,110)'))
det.close()
process.exit(0)
