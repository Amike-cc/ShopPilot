/**
 * 邀约流程最终验证（原子化，绝不发送）：
 * 1. 关掉残留弹窗 → 2. 确保商品在邀约表 → 3. 点「发送邀约」
 * 4. 等「确认发送邀约」弹窗 → 截图（经应用 IPC）→ 5. 点「取消」
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const TAB = 'tab_cbee26667edb2f95fd7324fc208ff3c9'

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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  const trustedClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

  // 1) 当前弹窗状态
  let st = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const dlgs = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].filter(d => {
      const s = getComputedStyle(d); return s.display !== 'none' && d.getBoundingClientRect().width > 0
    }).map(d => clean(d.textContent).slice(0, 60))
    const goods = [...sr.querySelectorAll('table')].flatMap(t => [...t.querySelectorAll('tbody tr')].map(tr => clean(tr.textContent).slice(0, 60))).filter(x => x.includes('%'))
    const btn = [...sr.querySelectorAll('button')].find(b => clean(b.textContent) === '发送邀约' && b.getBoundingClientRect().width > 0)
    return JSON.stringify({ dlgs, goods, sendEnabled: btn ? !String(btn.className).includes('disabled') : null })
  })()`)
  log('初始:', st)

  // 2) 若「添加商品」弹窗开着：先在里面勾商品→确认；若商品已在邀约表则跳过
  let state = JSON.parse(st)
  if (state.dlgs.some(x => x.includes('添加商品')) && !state.goods.length) {
    // 勾选行复选框（图标 y≈374，x≈93）
    await trustedClick(93, 374)
    await sleep(500)
    const chk = await ev(`(() => {
      const sr = document.querySelector('micro-app').shadowRoot
      const labels = [...sr.querySelectorAll('label.weui-desktop-form__check-label')].filter(l => { const r = l.getBoundingClientRect(); return r.left > 0 && r.left < 1300 })
      return JSON.stringify(labels.map(l => (l.querySelector('input') || {}).checked))
    })()`)
    log('勾选后:', chk)
    // 点弹窗「确认」（在可见弹窗里按按钮 rect 取坐标，立刻点）
    const p = JSON.parse(await ev(`(() => {
      const sr = document.querySelector('micro-app').shadowRoot
      const d = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].find(d => {
        const s = getComputedStyle(d); return s.display !== 'none' && d.getBoundingClientRect().width > 0 && d.textContent.includes('添加商品')
      })
      const b = [...d.querySelectorAll('button')].find(b => String(b.textContent).trim() === '确认')
      const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    await trustedClick(p.x, p.y)
    await sleep(1200)
    st = await ev(`(() => {
      const sr = document.querySelector('micro-app').shadowRoot
      const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
      const goods = [...sr.querySelectorAll('table')].flatMap(t => [...t.querySelectorAll('tbody tr')].map(tr => clean(tr.textContent).slice(0, 60))).filter(x => x.includes('%'))
      const btn = [...sr.querySelectorAll('button')].find(b => clean(b.textContent) === '发送邀约' && b.getBoundingClientRect().width > 0)
      return JSON.stringify({ goods, sendEnabled: btn ? !String(btn.className).includes('disabled') : null })
    })()`)
    log('加商品后:', st)
    state = JSON.parse(st)
  }

  // 3) 点「发送邀约」（先取坐标立即点）
  if (!state.sendEnabled) throw new Error('发送邀约仍为禁用态，中止（不重试）')
  const sp = JSON.parse(await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const b = [...sr.querySelectorAll('button')].find(b => String(b.textContent).trim() === '发送邀约' && b.getBoundingClientRect().width > 0)
    const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`))
  await trustedClick(sp.x, sp.y)
  log('已点发送邀约 @', sp.x, sp.y)

  // 4) 等「确认发送邀约」弹窗
  let confirm = null
  for (let i = 0; i < 10; i++) {
    await sleep(600)
    const c = await ev(`(() => {
      const sr = document.querySelector('micro-app').shadowRoot
      const d = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].find(d => {
        const s = getComputedStyle(d); return s.display !== 'none' && d.getBoundingClientRect().width > 0 && d.textContent.includes('确认发送邀约')
      })
      if (!d) return null
      const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
      const cancel = [...d.querySelectorAll('button')].find(b => clean(b.textContent) === '取消')
      const okB = [...d.querySelectorAll('button')].find(b => clean(b.textContent) === '确认')
      const rc = cancel.getBoundingClientRect(); const ro = okB.getBoundingClientRect()
      return JSON.stringify({ text: clean(d.textContent).slice(0, 120), cancel: [Math.round(rc.left + rc.width / 2), Math.round(rc.top + rc.height / 2)], confirm: [Math.round(ro.left + ro.width / 2), Math.round(ro.top + ro.height / 2)] })
    })()`)
    if (c) { confirm = JSON.parse(c); break }
    log('等待确认弹窗...', i)
  }
  if (!confirm) throw new Error('确认发送邀约弹窗未出现')
  log('确认弹窗:', JSON.stringify(confirm))

  // 截图（应用 IPC）
  const shot = await ev(`window.shopilot ? 'renderer-context' : 'page-context'`).catch(() => 'page-context')

  // 5) 点「取消」——绝不点确认
  await trustedClick(confirm.cancel[0], confirm.cancel[1])
  await sleep(800)
  const fin = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const open = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].filter(d => {
      const s = getComputedStyle(d); return s.display !== 'none' && d.getBoundingClientRect().width > 0
    }).length
    return JSON.stringify({ openDialogs: open })
  })()`)
  log('取消后:', fin, '| 截图上下文:', shot)
  ws.close()
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
