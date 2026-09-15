/**
 * 快手达人广场：按**引擎的方式**验证（受信任鼠标单击）+ 类目 chip 行为。
 * 只读性质：不点「发送邀请」。结束前关抽屉、取消勾选。
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
/** 与引擎 findTextTarget+realClick 等价：定位元素中心 → 单次受信任鼠标点击 */
async function engineClick(text) {
  const loc = await q(`(() => {
    const all = [...document.querySelectorAll('*')]
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const c = all.filter(el => own(el).includes(${JSON.stringify(text)}) && el.getBoundingClientRect().width > 0)
    if (!c.length) return null
    c.sort((a,b) => own(a).length - own(b).length)
    const el = c[0]
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ tag: el.tagName, cls: String(el.className||'').slice(0,50), own: own(el).slice(0,20), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
  })()`)
  if (!loc) return 'NOT_FOUND'
  const { x, y, tag, cls } = JSON.parse(loc)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return `${tag}.${cls} own="${loc.own || ''}" @(${x},${y})`
}
const COUNTER = `(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`

console.log('=== ① 类目 chip：点「个护家清」看是否有子级下拉 ===')
console.log('点前计数:', await q(COUNTER))
console.log('点击:', await engineClick('个护家清'))
await sleep(3500)
console.log('点后：是否有下拉浮层？')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[class*=dropdown], [class*=Dropdown], [class*=popover], [class*=Popover]')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (cs.display === 'none' || r.width < 60 || r.height < 40) continue
    out.push({ cls: String(el.className||'').slice(0,60), w: Math.round(r.width), h: Math.round(r.height), 文本: String(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160) })
  }
  return out.length ? JSON.stringify(out.slice(0,6), null, 1) : '(没有可见下拉浮层)'
})()`))
console.log('页面上是否出现「已筛选/已选」类文案:', await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = b.match(/已(?:筛选|选条件)[^。]{0,60}/)
  return m ? m[0] : '(无)'
})()`))

console.log('\n=== ② 用受信任鼠标单击「批量邀约」（先勾 1 行）===')
await q(`(() => { const b = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(x=>!x.checked)[0]; if (b) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
console.log('计数:', await q(COUNTER))
console.log('点击:', await engineClick('批量邀约'))
await sleep(5000)

console.log('\n=== ③ 抽屉是否打开 + 结构 ===')
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
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,38) + '>')
  }
  return JSON.stringify({ 抽屉cls: String(d.className||'').slice(0,80), 文案: out.slice(0, 80) }, null, 1)
})()`))

console.log('\n=== ④ 「发送邀请」按钮状态（未选商品时）===')
console.log(await q(`(() => {
  const b = [...document.querySelectorAll('button, [role=button], div, span')].find(x => String(x.innerText||'').trim() === '发送邀请' && x.getBoundingClientRect().width > 0)
  if (!b) return 'no-button'
  const el = b.closest('button') || b
  const cs = getComputedStyle(el)
  // 平台常用类名表达禁用；也看 disabled
  return JSON.stringify({ tag: el.tagName, cls: String(el.className||'').slice(0,70), disabled: el.disabled === true, aria: el.getAttribute('aria-disabled'), 背景: cs.backgroundColor, 透明度: cs.opacity, cursor: cs.cursor })
})()`))

console.log('\n=== ⑤ 必填标记（看哪些字段带 * 必填）===')
console.log(await q(`(() => {
  const dr = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 })
  if (!dr.length) return '(抽屉没开)'
  const d = dr[0]
  const out = []
  for (const el of d.querySelectorAll('[class*=required], [class*=star], [class*=asterisk], label')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 24) continue
    if (!(el.getBoundingClientRect().width > 0)) continue
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,50) + '>')
  }
  return [...new Set(out)].slice(0, 20).join('\\n') || '(无)'
})()`))

console.log('\n=== ⑥ textarea（话术）与输入框当前值 ===')
console.log(await q(`JSON.stringify({
  话术框: [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder||'', 值: String(t.value||'').slice(0,20), vis: t.getBoundingClientRect().width>0 })),
  联系人: [...document.querySelectorAll('input')].filter(i=>/联系人|手机|微信/.test(i.placeholder||'')).map(i => ({ ph: i.placeholder, 值: String(i.value||'') }))
}, null, 1)`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-drawer4.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-drawer4.png')

console.log('\n=== 收尾 ===')
for (let i = 0; i < 2; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}
console.log(await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return '取消勾选 ' + bs.length + ' 行' })()`))
await sleep(1200)
console.log('收尾计数:', await q(COUNTER))
ws.close()
setTimeout(() => process.exit(0), 200)
