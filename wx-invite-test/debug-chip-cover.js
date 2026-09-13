/** 诊断：刷新 → JS 点 玩具乐器 → 检查 智能家居 坐标处的元素与可点性 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  let c = null
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('daren-square'))) {
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
    if (r.result?.value > 0) { c = { send }; break }
    ws.close()
  }
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250))
    return r.result.value
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  await ev('location.reload();1')
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await ev(`document.querySelectorAll('tbody tr[data-row-key]').length > 0`).catch(() => false)) break }
  await sleep(2000)
  // JS 点第一个 chip（选中）
  console.log('select first:', await ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const row=[...document.querySelectorAll('label,div,span')].find(e=>own(e)==='\u4e3b\u63a8\u7c7b\u76ee');const item=row&&row.closest('.auxo-form-item-row');const a=[...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')][0];a.click();return a.className})()`))
  await sleep(1500)
  const diag = JSON.parse(await ev(`(() => {
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const row = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
    const item = row && row.closest('.auxo-form-item-row')
    const a = [...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].find(x => own(x.querySelector('.auxo-space-item span') || x) === '\u667a\u80fd\u5bb6\u5c45')
    const r = a.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
    const at = document.elementFromPoint(cx, cy)
    const pops = [...document.querySelectorAll('.quick-filter-cascader-popover')]
    return JSON.stringify({
      chipRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      point: [cx, cy],
      atPoint: at ? { tag: at.tagName, cls: String(at.className).slice(0, 50), text: String(at.innerText || '').replace(/\\s+/g, ' ').slice(0, 20) } : null,
      popovers: pops.map(p => { const pr = p.getBoundingClientRect(); return { left: Math.round(pr.left), top: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), display: getComputedStyle(p).display } })
    }, null, 1)
  })()`))
  console.log(diag)
  // 真实鼠标点击 智能家居
  const d = JSON.parse(diag)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: d.point[0], y: d.point[1], button: 'none' })
  await sleep(300)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d.point[0], y: d.point[1], button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d.point[0], y: d.point[1], button: 'left', clickCount: 1 })
  await sleep(2000)
  console.log('after real click:', await ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const row=[...document.querySelectorAll('label,div,span')].find(e=>own(e)==='\u4e3b\u63a8\u7c7b\u76ee');const item=row&&row.closest('.auxo-form-item-row');const a=[...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].find(x=>own(x.querySelector('.auxo-space-item span')||x)==='\u667a\u80fd\u5bb6\u5c45');return a.className})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
