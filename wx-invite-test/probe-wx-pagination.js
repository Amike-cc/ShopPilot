/**
 * 探真实广场的分页机制（只翻页，不发任何邀约）：
 * 看「下一页」是改 URL 还是内部刷新、每页行数、页码按钮是否可点、最后一页按钮状态
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function page(urlPart, budgetMs = 40000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
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
        return { url: t.url, send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 1500))
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SNAP = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
  const details = all.filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0)
  // 用行容器文本去重，算真实行数 + 取前 3 行的特征
  const seen = new Set(); const rows = []
  for (const el of details) {
    const row = el.closest('tr') || el.parentElement
    const k = String((row && row.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
    if (seen.has(k)) continue
    seen.add(k); rows.push(k)
  }
  const btn = (t) => { const el = all.find(e => own(e) === t); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    const dis = /disabled|is-disabled/i.test(String(el.className||'')) || el.getAttribute('aria-disabled') === 'true'
    return { text: t, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], visible: r.width > 0 && r.height > 0, disabledByClass: dis, point: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)], topmost: (() => { const at = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return at ? at.tagName + '.' + String(at.className || '').slice(0, 30) : null })() } }
  // 当前页标记：页码里 class 带 current/active 的
  const activeNums = all.filter(el => /^\\d+$/.test(own(el)) && /(current|active|selected)/i.test(String(el.className || ''))).map(el => own(el))
  return JSON.stringify({ url: location.href, rows: rows.length, samples: rows.slice(0, 3), 下一页: btn('下一页'), 上一页: btn('上一页'), 当前页码: activeNums })
})()`

const p = await page('findersquare/find')
if (!p) { console.log('没有广场页'); process.exit(1) }
console.log('初始：', await p.ev(SNAP))
// 翻页控件在页面底部（y≈2547）——先把页面滚到底，再取坐标
console.log('滚动到底：', await p.ev(`(() => { window.scrollTo(0, document.body.scrollHeight); return window.scrollY })()`))
await sleep(1200)
// 真实点击「下一页」（CDP 输入，isTrusted）
const pt = JSON.parse(await p.ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '下一页')
  if (!el) return 'null'
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)])
})()`))
if (pt && Array.isArray(pt)) {
  console.log('点「下一页」于点', pt)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await p.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(60)
  }
  await sleep(3000)
  console.log('翻页后：', await p.ev(SNAP))
} else {
  console.log('「下一页」没找到（可能不在当前视口内）')
}
p.close()
process.exit(0)
