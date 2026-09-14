/** 真机确认：点固定右列里的「详情」副本能否打开达人详情页（同时列出点击前后的标签页） */
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
      return {
        send,
        ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value,
        close: () => ws.close()
      }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('没有活跃广场页'); process.exit(0) }
  // 找"可见且在最上层"的 详情（即固定右列那份）
  const pt = JSON.parse(await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner } return el }
    for (const el of all) {
      if (own(el) !== '详情') continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const at = deepAt(cx, cy)
      if (at && own(at) === '详情') return JSON.stringify({ x: cx, y: cy, cls: String(at.className || '').slice(0, 40) })
    }
    return 'null'
  })()`))
  console.log('可点的「详情」:', pt)
  if (pt === 'null') { console.log('没有可点的详情'); process.exit(1) }
  const p = JSON.parse(pt)
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
  await sleep(200)
  await sq.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  console.log('已真实点击')
  await sleep(6000)
  const urls = JSON.parse(await sq.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf');return JSON.stringify((r.data.tabs||[]).map(x=>String(x.url||'').slice(0,70)))})()`).catch(() => '[]'))
  console.log('点击后标签页:', JSON.stringify(urls, null, 1))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
