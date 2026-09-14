/** 逐个尝试所有「详情」元素（JS 点击），看哪一个能跳到详情页 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) {
      return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('没有活跃广场页'); process.exit(0) }
  console.log('详情元素清单:', await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner } return el }
    const out = []
    for (const el of all) {
      if (own(el) !== '详情') continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const at = deepAt(cx, cy)
      out.push({ tag: el.tagName, href: el.getAttribute('href'), cls: String(el.className || '').slice(0, 30), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], topmost: at === el || (at && el.contains(at)) })
    }
    return JSON.stringify(out.slice(0, 8), null, 1)
  })()`))
  // 依次 JS 点击每个详情，每次后检查 URL
  const n = Number(await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    let c = 0
    for (const el of all) { if (own(el) === '详情' && el.getBoundingClientRect().width > 0) c++ }
    return c
  })()`))
  console.log('可见详情数:', n)
  for (let i = 0; i < Math.min(n, 5); i++) {
    await sq.ev(`(() => {
      const all = []
      const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const list = all.filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0)
      const el = list[${i}]
      if (el) el.click()
      return 1
    })()`)
    await sleep(4000)
    const url = await sq.ev('location.href.slice(0, 90)')
    console.log(`第 ${i + 1} 个 → URL:`, url)
    if (!url.includes('findersquare/find')) break
  }
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
