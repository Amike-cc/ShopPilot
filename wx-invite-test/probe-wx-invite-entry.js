/**
 * 探真实达人详情页的「邀请带货」：元素类型/位置/是否被遮挡/点了之后 URL 怎么变。
 * 只读 + 点击（该按钮只是进表单页，不发送任何邀约）。
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
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function pick(urlPart, budgetMs = 40000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
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

// 广场 → 点第一个「详情」（真实点击），拿到详情页
const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
const tabId = p.active || (p.first && p.first[0])
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/find');return 1})()`)
await sleep(9000)

const sq = await pick('findersquare/find')
// 点第一个可见「详情」
const pt = JSON.parse(await sq.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  for (const el of all) {
    if (own(el) !== '详情') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (r.top < 100 || r.bottom > innerHeight) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    return JSON.stringify({ point: [x, y], topmost: at ? at.tagName + '.' + String(at.className || '').slice(0, 40) : null, self: at === el || el.contains(at) })
  }
  return 'null'
})()`))
console.log('详情点:', JSON.stringify(pt), ' tab:', await sq.ev('window.innerWidth'))
if (pt && pt.point) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await sq.send('Input.dispatchMouseEvent', { type, x: pt.point[0], y: pt.point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(70)
  }
}
await sleep(5000)
sq.close()

// 找到新开的详情页
const det = await pick('finder-detail', 30000)
if (!det) { console.log('详情页没出现'); process.exit(1) }
console.log('详情页:', det.url.slice(0, 120), 'w=', await det.ev('window.innerWidth'))
console.log('「邀请带货」候选:', await det.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  const out = []
  for (const el of all) {
    if (!own(el).includes('邀请带货')) continue
    const r = el.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = r.width > 0 && r.height > 0 ? deepAt(x, y) : null
    const clickable = el.closest('button, a, [role=button], [class*=btn]') || el
    out.push({
      tag: el.tagName + '.' + String(el.className || '').slice(0, 40),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      topmost: at ? at.tagName + '.' + String(at.className || '').slice(0, 40) : null,
      hitSelf: at === el || el.contains(at) || (clickable && clickable.contains(at)),
      clickable: clickable.tagName + '.' + String(clickable.className || '').slice(0, 44),
      href: clickable.getAttribute && clickable.getAttribute('href'),
      disabled: /disabled/i.test(String(clickable.className || '')) || clickable.disabled === true
    })
  }
  return JSON.stringify(out, null, 1)
})()`))

// 记录跳转方式后真实点击
console.log('装探针:', await det.ev(`(() => {
  window.__log = []
  const o = window.open; window.open = function (...a) { window.__log.push(['open', String(a[0]).slice(0, 60)]); return o.apply(this, a) }
  for (const m of ['pushState', 'replaceState']) { const f = history[m]; history[m] = function (...a) { window.__log.push([m, String(a[2]).slice(0, 60)]); return f.apply(this, a) } }
  return 'ok ' + location.href.slice(0, 60)
})()`))
const ip = JSON.parse(await det.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  for (const el of all) {
    if (!own(el).includes('邀请带货')) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top > 60 && r.bottom < innerHeight)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    return JSON.stringify({ point: [x, y], atSelf: at === el || el.contains(at) })
  }
  return 'null'
})()`))
console.log('点「邀请带货」:', JSON.stringify(ip))
if (ip && ip.point) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await det.send('Input.dispatchMouseEvent', { type, x: ip.point[0], y: ip.point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(70)
  }
}
await sleep(5000)
console.log('点击后:', await det.ev(`JSON.stringify({ url: location.href.slice(0, 110), log: window.__log })`))
det.close()
process.exit(0)
