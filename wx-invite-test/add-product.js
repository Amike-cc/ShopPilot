/**
 * 邀约页「添加商品」流程：点开弹窗 → 勾第一个可勾商品 → 弹窗内「确认」。
 * 只把商品加入邀约草稿，不发送邀约。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find(x => x.url.includes('initiate-invite'))
  if (!t) throw new Error('initiate-invite 页不在打开的目标里')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(method + ' ' + JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true, awaitPromise: true })
    .then(r => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value })
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  // 1) 点「添加商品」打开弹窗
  const open = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const btn = [...sr.querySelectorAll('button')].find(b => String(b.textContent).trim() === '添加商品' && b.getBoundingClientRect().width > 0)
    if (!btn) return 'no-btn'
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`)
  if (open === 'no-btn') throw new Error('找不到「添加商品」按钮')
  const p1 = JSON.parse(open)
  await clickAt(p1.x, p1.y)
  await sleep(1200)

  // 2) 在可见弹窗里找第一个商品行复选框并点它
  const row = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const wrp = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].find(d => d.getBoundingClientRect().width > 0 && d.textContent.includes('添加商品'))
    if (!wrp) return null
    const boxes = [...wrp.querySelectorAll('input[type=checkbox]')]
    const info = boxes.map(b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: b.checked, w: r.width } })
    const rowCount = wrp.querySelectorAll('tr').length
    return JSON.stringify({ boxes: info, rowCount })
  })()`)
  if (!row) throw new Error('添加商品弹窗未出现')
  const rowInfo = JSON.parse(row)
  console.log('弹窗内复选框:', JSON.stringify(rowInfo))
  if (!rowInfo.boxes.length) throw new Error('弹窗里没有复选框')
  const target = rowInfo.boxes.find(b => !b.checked)
  if (target) {
    await clickAt(Math.round(target.x), Math.round(target.y))
    await sleep(500)
  }

  // 3) 点弹窗底部「确认」
  const confirm = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const wrp = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].find(d => d.getBoundingClientRect().width > 0 && d.textContent.includes('添加商品'))
    const btn = [...wrp.querySelectorAll('button')].find(b => String(b.textContent).trim() === '确认')
    if (!btn) return 'no-confirm'
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, cls: String(btn.className) })
  })()`)
  if (confirm === 'no-confirm') throw new Error('弹窗里没有「确认」按钮')
  const p3 = JSON.parse(confirm)
  await clickAt(Math.round(p3.x), Math.round(p3.y))
  await sleep(1200)

  // 4) 回读：邀约商品表格 + 发送按钮状态
  const after = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim()
    const btn = [...sr.querySelectorAll('button')].find(b => String(b.textContent).trim() === '发送邀约' && b.getBoundingClientRect().width > 0)
    const goodsRows = [...sr.querySelectorAll('tr')].map(tr => clean(tr.textContent).slice(0, 80)).filter(t => t.includes('¥') || t.includes('%'))
    return JSON.stringify({ sendCls: String(btn.className), goodsRows: goodsRows.slice(0, 5) })
  })()`)
  console.log('添加后:', after)
  ws.close()
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
