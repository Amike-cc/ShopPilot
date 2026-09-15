/**
 * 快手达人广场：确认勾选方式（单击 vs 真实鼠标）+ 「批量邀约」抽屉结构。
 * 只读性质：勾 1 行看结构，**绝不点最终发送**；结束前取消勾选、关闭抽屉。
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
  const re = /已选(?:择)?\\s*(\\d+)\\s*(?:位达人|条|个)/;
  for (const el of document.querySelectorAll('div,span,p,b,strong,em')) {
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 40) continue;
    const m = re.exec(t);
    if (m) return m[0] + ' => ' + m[1];
  }
  return null;
})()`
console.log('起始计数:', await q(COUNTER))

console.log('\n=== A. 单击第一个 checkbox 的 label（只点一次）===')
console.log(await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')]
  if (!boxes.length) return 'no-checkbox'
  const b = boxes[0]
  const label = b.closest('label') || b
  label.click()
  return 'label.click() 已发; checked=' + b.checked
})()`))
await sleep(2000)
console.log('计数:', await q(COUNTER))

console.log('\n=== B. 若没选中，试真实鼠标点该复选框坐标 ===')
const box = await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')]
  if (!boxes.length) return null
  const b = boxes[0]
  b.scrollIntoView({ block: 'center' })
  const r = (b.closest('label') || b).getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height), checked: b.checked })
})()`)
console.log('目标:', box)
if (box) {
  const { x, y } = JSON.parse(box)
  // 与引擎 realClick 一致的三段式
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(2000)
  console.log('真实鼠标点击后计数:', await q(COUNTER))
}

console.log('\n=== C. 打开「批量邀约」抽屉 ===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => own(el) === '批量邀约' && el.getBoundingClientRect().width > 0)
  if (!cands.length) return 'no-el'
  cands.sort((a,b) => own(a).length - own(b).length)
  let n = cands[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ clicked: own(cands[0]), chain: done })
})()`))
await sleep(4500)

console.log('\n=== D. 抽屉结构 ===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const fixed = all.filter(el => {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false
    const r = el.getBoundingClientRect()
    return r.width > 320 && r.height > 220 && r.top < innerHeight && r.bottom > 0
  }).map(el => {
    const r = el.getBoundingClientRect()
    return { tag: el.tagName, cls: String(el.className||'').slice(0, 70), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) }
  }).slice(0, 10)
  const ta = [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder || '', cls: String(t.className||'').slice(0,50), vis: t.getBoundingClientRect().width > 0 }))
  return JSON.stringify({ 浮层: fixed, textarea: ta }, null, 1)
})()`))

console.log('\n=== E. 抽屉内按钮/标题文案 ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('button, [role=button], span, div, h1, h2, h3')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 14) continue
    if (!/确认|发送|取消|关闭|邀约|提交|话术|沟通|留言/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '> y=' + Math.round(r.top) + ' w=' + Math.round(r.width))
  }
  return [...new Set(out)].slice(0, 30).join('\\n')
})()`))

console.log('\n=== F. 抽屉正文（取 fixed 浮层内的文本）===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const fixed = all.filter(el => {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed') return false
    const r = el.getBoundingClientRect()
    return r.width > 320 && r.height > 220
  })
  if (!fixed.length) return '(没有 fixed 浮层)'
  const t = String(fixed[fixed.length-1].innerText||'').replace(/\\s+/g,' ').trim()
  return t.slice(0, 900)
})()`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-drawer2.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-drawer2.png')

// 收尾：取消勾选（点回同一行）+ 关抽屉（Esc）
console.log('\n=== 收尾 ===')
await q(`(() => { const b = document.querySelector('tbody input[type=checkbox]'); if (b && (b.checked || /已选\\s*\\d/.test(String(document.body.innerText||'')))) return 'still-selected' ; return 'ok' })()`)
ws.close()
setTimeout(() => process.exit(0), 200)
