/**
 * 对照实验：主推类目 chip 怎么点才生效
 *  A) 合成 click 在最内层 SPAN（当前实现的做法）
 *  B) 合成 click 在 A.auxo-btn（chip 本体）
 *  C) CDP 真实鼠标点击（Input.dispatchMouseEvent）在 chip 中心
 * 每步后读：chip 的祖先类名、已筛选标签、列表行数
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CAT = '\u4e2a\u62a4\u5bb6\u6e05'

async function connectLive() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter(t => t.type === 'page' && t.url.includes('daren-square'))
  for (const t of list) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let seq = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++seq
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth + "x" + window.innerHeight', returnByValue: true })
    if (r.result?.value && r.result.value !== '0x0') {
      const ev = async (expr) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
        if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 200))
        return res.result.value
      }
      return { ev, send, close: () => ws.close() }
    }
    ws.close()
  }
  throw new Error('没有活跃的达人广场页面')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const READ = `(() => {
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()
  const chipSpan = [...document.querySelectorAll('span')].find(e => own(e) === ${JSON.stringify(CAT)} && e.closest('.quick-filter-button-enums'))
  const anchor = chipSpan ? chipSpan.closest('a') : null
  const filtered = [...document.querySelectorAll('*')].find(e => own(e) === '\u5df2\u7b5b\u9009')
  const rows = [...document.querySelectorAll('tbody tr[data-row-key]')]
  const withCat = rows.filter(tr => text(tr).includes(${JSON.stringify(CAT)})).length
  return JSON.stringify({
    anchorCls: anchor ? String(anchor.className) : null,
    anchorStyleCls: anchor ? String(anchor.getAttribute('class')) : null,
    filteredTags: filtered ? text(filtered.parentElement).slice(0, 120) : null,
    rows: rows.length,
    rowsWithCat: withCat,
    firstRow: rows[0] ? text(rows[0]).slice(0, 50) : null
  })
})()`

const CENTER = `(() => {
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const span = [...document.querySelectorAll('span')].find(e => own(e) === ${JSON.stringify(CAT)} && e.closest('.quick-filter-button-enums'))
  const anchor = span ? span.closest('a') : null
  if (!anchor) return null
  const r = anchor.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
})()`

async function main() {
  const c = await connectLive()
  const out = { before: JSON.parse(await c.ev(READ)) }

  // A) 合成 click 在最内层 span
  await c.ev(`(() => {
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const span = [...document.querySelectorAll('span')].find(e => own(e) === ${JSON.stringify(CAT)} && e.closest('.quick-filter-button-enums'));
    if (span) span.click();
    return true
  })()`)
  await sleep(2500)
  out.afterA_spanSyntheticClick = JSON.parse(await c.ev(READ))

  // B) 合成 click 在 <a>
  await c.ev(`(() => {
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const span = [...document.querySelectorAll('span')].find(e => own(e) === ${JSON.stringify(CAT)} && e.closest('.quick-filter-button-enums'));
    const a = span && span.closest('a');
    if (a) a.click();
    return true
  })()`)
  await sleep(2500)
  out.afterB_anchorSyntheticClick = JSON.parse(await c.ev(READ))

  // C) 真实鼠标点击在 <a> 中心
  const center = JSON.parse(await c.ev(CENTER))
  if (center) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' })
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 })
    await sleep(2500)
    out.center = center
    out.afterC_realMouse = JSON.parse(await c.ev(READ))
  }
  console.log(JSON.stringify(out, null, 1))
  c.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
