/**
 * 用 CDP Input 域把「受信任」事件打进邀约页表单：点击聚焦 → 全选删除 → insertText。
 * 用法：node trusted-type.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const SCRIPT_TEXT = process.argv[2] || '您好，我们是微信小店测试店铺，主营家居日用好物，诚邀您合作带货，佣金与选品都可协商，期待您的回复！'

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
  const ev = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true })
    .then(r => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value })

  // 目标元素中心坐标（聚焦由真实点击完成，满足框架的 focus 处理）
  const posJson = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const ph = ${JSON.stringify(process.argv[3] || '合作说明')}
    const el = [...sr.querySelectorAll('textarea,input')].find(t => t.getBoundingClientRect().width > 0 && (t.placeholder || '').includes(ph))
    if (!el) return null
    const b = el.getBoundingClientRect()
    return JSON.stringify({ x: b.left + Math.min(b.width / 2, b.width - 10), y: b.top + b.height / 2 })
  })()`)
  if (!posJson) throw new Error('找不到目标输入框')
  const pos = JSON.parse(posJson)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 200))
  // Ctrl+A 全选 → Delete → insertText（insertText 走真实输入管线，产生受信任 input 事件）
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await send('Input.insertText', { text: SCRIPT_TEXT })
  await new Promise(r => setTimeout(r, 400))
  const chk = await ev(`(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const ph = ${JSON.stringify(process.argv[3] || '合作说明')}
    const el = [...sr.querySelectorAll('textarea,input')].find(t => t.getBoundingClientRect().width > 0 && (t.placeholder || '').includes(ph))
    const counter = [...sr.querySelectorAll('*')].filter(e => e.childElementCount === 0 && /\\d+\\/200/.test(String(e.textContent).trim())).map(e => String(e.textContent).trim())
    const btn = [...sr.querySelectorAll('button')].find(b => String(b.textContent).trim() === '发送邀约' && b.getBoundingClientRect().width > 0)
    return JSON.stringify({ value: String(el ? el.value : '').slice(0, 30), counter, sendCls: btn ? String(btn.className) : null })
  })()`)
  console.log('RESULT:', chk)
  ws.close()
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
