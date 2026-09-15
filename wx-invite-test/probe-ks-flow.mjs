/**
 * 快手提交流程：先**刷新页面**清干净残留状态，再用受信任鼠标走一遍
 * （勾 1 行 → 点「批量邀约」），确认抽屉能打开；记录可靠触发方式。
 * 不点「发送邀请」。结束关抽屉、取消勾选。
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
const COUNTER = `(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`
const DRAWER = `(() => {
  const dr = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })
  return dr.length ? String(dr[0].className||'').slice(0,60) : null
})()`

console.log('=== ① 刷新页面清残留 ===')
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(14000)
console.log('计数:', await q(COUNTER), '抽屉:', await q(DRAWER))
console.log('表格行数:', await q(`document.querySelectorAll('tbody tr').length`))

console.log('\n=== ② 勾 1 行（标签与 tbody 两种选择器都试，记录哪种生效）===')
console.log(await q(`(() => {
  const out = []
  for (const sel of ['tbody input[type=checkbox]', 'tbody label']) {
    const els = [...document.querySelectorAll(sel)]
    out.push(sel + ' × ' + els.length)
  }
  return out.join(' | ')
})()`))
console.log(await q(`(() => {
  const b = document.querySelector('tbody input[type=checkbox]')
  if (!b) return 'no-box'
  const label = b.closest('label')
  return JSON.stringify({ 有label: !!label, labelCls: label ? String(label.className||'').slice(0,50) : null, boxCls: String(b.className||'').slice(0,50) })
})()`))
console.log('JS 点 label:', await q(`(() => { const b = document.querySelector('tbody input[type=checkbox]'); const l = b.closest('label')||b; l.click(); return 'checked=' + b.checked })()`))
await sleep(2000)
console.log('计数:', await q(COUNTER))

console.log('\n=== ③ 受信任鼠标点「批量邀约」（精确命中 BUTTON 本身）===')
const loc = await q(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const b = btns.find(x => String(x.innerText||'').replace(/\\s+/g,'').trim() === '批量邀约')
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return JSON.stringify({ cls: String(b.className||'').slice(0,60), disabled: b.disabled, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
})()`)
console.log('按钮:', loc)
if (loc) {
  const { x, y } = JSON.parse(loc)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
await sleep(5000)
console.log('抽屉:', await q(DRAWER))

if (!(await q(DRAWER))) {
  console.log('\n=== ③b 回退：JS 逐级点（SPAN→BUTTON→DIV）===')
  console.log(await q(`(() => {
    const all = [...document.querySelectorAll('*')]
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const c = all.filter(el => own(el) === '批量邀约' && el.getBoundingClientRect().width > 0)
    if (!c.length) return 'no-el'
    let n = c[0]; const done = []
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
    return JSON.stringify(done)
  })()`))
  await sleep(5000)
  console.log('抽屉:', await q(DRAWER))
}

console.log('\n=== ④ 抽屉内容（若已开）===')
console.log(await q(`(() => {
  const dr = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })
  if (!dr.length) return '(没打开)'
  const d = dr[0]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of d.querySelectorAll('*')) {
    const t = own(el).trim()
    if (!t || t.length > 30) continue
    if (!(el.getBoundingClientRect().width > 0)) continue
    const k = t + '|' + el.tagName
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '>')
  }
  return out.slice(0, 80).join('\\n')
})()`))
console.log('\n发送按钮:', await q(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => String(x.innerText||'').replace(/\\s+/g,'').trim() === '发送邀请')
  if (!b) return 'no-button'
  const cs = getComputedStyle(b)
  return JSON.stringify({ cls: String(b.className||'').slice(0,70), disabled: b.disabled, aria: b.getAttribute('aria-disabled'), 背景: cs.backgroundColor, opacity: cs.opacity, cursor: cs.cursor })
})()`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-drawer5.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-drawer5.png')

console.log('\n=== 收尾 ===')
for (let i = 0; i < 2; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}
console.log(await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return '取消 ' + bs.length })()`))
await sleep(1200)
console.log('收尾计数:', await q(COUNTER), '抽屉:', await q(DRAWER))
ws.close()
setTimeout(() => process.exit(0), 200)
