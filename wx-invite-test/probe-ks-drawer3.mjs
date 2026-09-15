/**
 * 快手提交流程探查：勾 1 行（JS 点 label）→ 点「批量邀约」→ dump 抽屉结构。
 * 绝不点最终确认发送。结束前关抽屉（Esc）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const COUNTER = `(() => {
  const re = /已选(?:择)?\\s*(\\d+)/;
  for (const el of document.querySelectorAll('div,span,p,b,strong,em')) {
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 40) continue;
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
})()`

console.log('起始:', await q(COUNTER))
console.log('\n=== 勾 2 行（JS label.click）===')
console.log(await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(b => !b.checked)
  const picked = []
  for (const b of boxes.slice(0, 2)) {
    const label = b.closest('label') || b
    label.click()
    picked.push('checked=' + b.checked)
  }
  return JSON.stringify(picked)
})()`))
await sleep(2500)
console.log('计数:', await q(COUNTER))

console.log('\n=== 点「批量邀约」===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => own(el) === '批量邀约' && el.getBoundingClientRect().width > 0)
  if (!cands.length) return 'no-el'
  cands.sort((a,b) => own(a).length - own(b).length)
  const btn = cands[0].closest('button') || cands[0]
  const dis = btn.disabled === true || /disabled/i.test(String(btn.className||''))
  btn.click()
  return JSON.stringify({ tag: btn.tagName, cls: String(btn.className||'').slice(0,50), disabled: dis })
})()`))
await sleep(5000)

console.log('\n=== 抽屉/弹窗（含 z-index 高的容器）===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.width < 300 || r.height < 180) continue
    const z = parseInt(cs.zIndex || '0', 10)
    const isFixed = cs.position === 'fixed'
    if (!isFixed && !(z >= 100 && cs.position !== 'static')) continue
    // 只关心"新增的大块"
    out.push({ tag: el.tagName, cls: String(el.className||'').slice(0,64), pos: cs.position, z, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) })
  }
  return JSON.stringify(out.slice(0, 14), null, 1)
})()`))

console.log('\n=== 页面新增文本（找"邀约/话术/确认"）===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('button, [role=button], span, div, h1, h2, h3, label, p')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 20) continue
    if (!/邀约|话术|沟通|留言|发送|确认|取消|关闭|说明|商品|佣金|数量/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,34) + '> y=' + Math.round(r.top))
  }
  return [...new Set(out)].slice(0, 40).join('\\n')
})()`))

console.log('\n=== textarea / 可见输入框 ===')
console.log(await q(`JSON.stringify({
  textarea: [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder||'', cls: String(t.className||'').slice(0,44), vis: t.getBoundingClientRect().width>0 })),
  输入框: [...document.querySelectorAll('input')].filter(i => i.type !== 'checkbox' && i.getBoundingClientRect().width > 60).map(i => ({ type: i.type, ph: i.placeholder||'', cls: String(i.className||'').slice(0,44) }))
}, null, 1)`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-drawer3.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-drawer3.png')

// 关抽屉 + 取消勾选（把这一页的操作还原，避免留下已选状态）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1200)
console.log('\n=== 还原：取消勾选 ===')
console.log(await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(b => b.checked)
  for (const b of boxes) (b.closest('label') || b).click()
  return 'unchecked ' + boxes.length + ' 行'
})()`))
await sleep(1500)
console.log('收尾计数:', await q(COUNTER))
ws.close()
setTimeout(() => process.exit(0), 200)
