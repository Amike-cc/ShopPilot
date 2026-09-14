/** 打开「我的邀约」→ 点「邀请中(N)」页签 → 逐页读出发给谁、时间、状态 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

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
async function page(urlPart, budgetMs = 40000, exact = null) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
      if (exact) { let pn = ''; try { pn = new URL(t.url).pathname } catch { continue } if (pn !== exact) continue }
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
    await sleep(1200)
  }
}

const ROWS = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const rows = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  return JSON.stringify(rows)
})()`

const mi = await page('my-invite', 30000, '/shop/findersquare/my-invite')
if (!mi) { console.log('我的邀约页没打开'); process.exit(1) }
// 找「邀请中」页签坐标并真实点击
const pt = JSON.parse(await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  for (const el of all) {
    if (!/^邀请中/.test(own(el))) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top < 340)) continue
    return JSON.stringify({ t: own(el), point: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })
  }
  return 'null'
})()`))
console.log('「邀请中」页签:', JSON.stringify(pt))
if (!pt) { mi.close(); process.exit(1) }
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await mi.send('Input.dispatchMouseEvent', { type, x: pt.point[0], y: pt.point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(80)
}
await sleep(4000)
let rows = JSON.parse(await mi.ev(ROWS))
console.log(`第 1 页 ${rows.length - 1} 行：`)
for (const r of rows.slice(1)) console.log('   ', r.slice(0, 90))
// 翻下一页继续读（若有）
for (let page = 2; page <= 5; page++) {
  const np = JSON.parse(await mi.ev(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    for (const el of all) {
      if (own(el) !== '下一页') continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const cls = String(el.className || '')
      if (/disabled/i.test(cls)) return JSON.stringify({ disabled: true })
      el.scrollIntoView({ block: 'center' })
      const r2 = el.getBoundingClientRect()
      return JSON.stringify({ point: [Math.round(r2.left + r2.width / 2), Math.round(r2.top + r2.height / 2)] })
    }
    return 'null'
  })()`))
  if (!np || np.disabled || !np.point) { console.log(`（没有下一页了）`); break }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await mi.send('Input.dispatchMouseEvent', { type, x: np.point[0], y: np.point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(80)
  }
  await sleep(3500)
  rows = JSON.parse(await mi.ev(ROWS))
  console.log(`第 ${page} 页 ${rows.length - 1} 行：`)
  for (const r of rows.slice(1)) console.log('   ', r.slice(0, 90))
}
mi.close()
process.exit(0)
