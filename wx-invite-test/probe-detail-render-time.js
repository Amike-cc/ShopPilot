/**
 * 验证：达人详情页微应用是"渲染慢"还是"就是渲染不出来"？
 * 打开一个详情页，每 2 秒采样一次「邀请带货」是否存在、正文长度，持续 40 秒。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 从广场点一位「详情」（真实点击，让它新开标签页）——用当前广场页
const sqPage = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page' && x.url.includes('findersquare/find') && !x.url.includes('finder-detail'))
if (!sqPage) { console.log('没有广场页'); process.exit(0) }
const w2 = new WebSocket(sqPage.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

const before = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('finder-detail')).length
const pt = JSON.parse(await q2(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  for (const el of all) {
    if (own(el) !== '详情') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top > 120 && r.bottom < innerHeight)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    if (at === el || el.contains(at)) return JSON.stringify([x, y])
  }
  return 'null'
})()`))
if (!pt) { console.log('广场上没有可点的「详情」'); process.exit(1) }
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await snd('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(80)
}
console.log('已点「详情」，等待新标签页…')
let det = null
for (let i = 0; i < 20 && !det; i++) {
  await sleep(1000)
  const now = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('finder-detail'))
  if (now.length > before) det = now[now.length - 1]
}
if (!det) { console.log('详情页没开出来'); process.exit(1) }
console.log('详情页 URL:', String(det.url).slice(0, 95))
w2.close()

// 持续采样 40 秒
const w3 = new WebSocket(det.webSocketDebuggerUrl)
await new Promise((ok, err) => { w3.onopen = ok; w3.onerror = err })
let s3 = 0; const p3 = new Map()
w3.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p3.has(m.id)) { p3.get(m.id)(m); p3.delete(m.id) } }
const snd3 = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s3; p3.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w3.send(JSON.stringify({ id, method: m2, params: pp })) })
const q3 = async (expr) => (await snd3('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const t0 = Date.now()
for (let i = 0; i < 20; i++) {
  const r = await q3(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const txt = String(document.body ? document.body.innerText : '')
    return JSON.stringify({
      has邀请带货: all.some(el => own(el) === '邀请带货' && el.getBoundingClientRect().width > 0),
      微应用节点: document.querySelectorAll('micro-app').length,
      正文长度: txt.replace(/\\s+/g,' ').length,
      iframe数: document.querySelectorAll('iframe').length
    })
  })()`)
  console.log(`  +${String(Math.round((Date.now() - t0) / 1000)).padStart(2)}s  ${r}`)
  if (JSON.parse(r).has邀请带货) { console.log('→ 等待后**渲染出来了**（说明是渲染慢，应改为"等就绪"而不是跳过）'); break }
  await sleep(2000)
}
w3.close()
setTimeout(() => process.exit(0), 300)
