/**
 * 快手「带货邀约」抽屉深挖（只读 + 只到"发送前一步"）：
 *  A. 抽屉里所有文案元素（找确认弹窗线索 / 合作标签）
 *  B. 预渲染的 modal/dialog 容器（含隐藏的）→ 判断点发送后会不会弹确认框
 *  C. 「选择商品」弹窗结构
 *  D. 发送按钮的 disabled 判定依据（未选商品时是否禁用）
 * 绝不点「发送邀请」。结束前关抽屉并取消勾选。
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
const click = (text) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const c = all.filter(el => own(el) === ${JSON.stringify(text)} && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a,b) => own(a).length - own(b).length)
  let n = c[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ chain: done })
})()`)

console.log('=== 准备：勾 1 行 + 开抽屉 ===')
await q(`(() => { const b = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(x=>!x.checked)[0]; if (b) (b.closest('label')||b).click(); return 1 })()`)
await sleep(1500)
console.log('计数:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
await click('批量邀约')
await sleep(4500)

console.log('\n=== A. 抽屉内全部短文案（找标签/弹窗线索）===')
console.log(await q(`(() => {
  const drawer = [...document.querySelectorAll('[class*=drawer]')].filter(e => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().width > 400)[0]
  if (!drawer) return '(没找到 drawer)'
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of drawer.querySelectorAll('*')) {
    const t = own(el).trim()
    if (!t || t.length > 26) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const k = t + '|' + el.tagName
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '>')
  }
  return out.slice(0, 90).join('\\n')
})()`))

console.log('\n=== B. 全页 modal/dialog 容器（含隐藏）→ 点发送会不会弹确认框 ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog], [role=dialog]')) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0
    out.push({ cls: String(el.className||'').slice(0,56), 可见: vis, w: Math.round(r.width), h: Math.round(r.height), 文本: String(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 60) })
  }
  return out.length ? JSON.stringify(out.slice(0, 20), null, 1) : '(页面上没有 modal/dialog 类容器)'
})()`))

console.log('\n=== C. 「发送邀请」按钮状态 ===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('button, [role=button]')]
  const b = all.find(x => String(x.innerText||'').trim() === '发送邀请')
  if (!b) return 'no-send-button'
  const cs = getComputedStyle(b)
  return JSON.stringify({ cls: String(b.className||'').slice(0,70), disabled: b.disabled === true, aria: b.getAttribute('aria-disabled'), 背景: cs.backgroundColor, 颜色: cs.color, cursor: cs.cursor })
})()`))

console.log('\n=== D. 合作标签项（含是否可点）===')
console.log(await q(`(() => {
  const drawer = [...document.querySelectorAll('[class*=drawer]')].filter(e => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().width > 400)[0]
  if (!drawer) return '(没找到 drawer)'
  const out = []
  for (const el of drawer.querySelectorAll('label, [class*=tag], [class*=Tag], [class*=checkbox]')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 20) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const inp = el.querySelector('input[type=checkbox]')
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,36) + '> checked=' + (inp ? inp.checked : 'n/a'))
  }
  return [...new Set(out)].slice(0, 20).join('\\n')
})()`))

console.log('\n=== E. 点「选择商品」看弹窗结构 ===')
await click('选择商品')
await sleep(4500)
console.log(await q(`(() => {
  const ms = [...document.querySelectorAll('[class*=modal], [class*=Modal], [role=dialog]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.display!=='none' && r.width>300 && r.height>150 && cs.position==='fixed' })
  if (!ms.length) return '(没有可见的 modal)'
  const m = ms[ms.length-1]
  return JSON.stringify({ cls: String(m.className||'').slice(0,70), w: Math.round(m.getBoundingClientRect().width), h: Math.round(m.getBoundingClientRect().height), 文本: String(m.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 500) }, null, 1)
})()`))
console.log('弹窗内复选框:', await q(`(() => {
  const ms = [...document.querySelectorAll('[class*=modal], [role=dialog]')].filter(e => e.getBoundingClientRect().width > 300)
  if (!ms.length) return 'none'
  const m = ms[ms.length-1]
  return JSON.stringify({ 复选框数: m.querySelectorAll('input[type=checkbox]').length, 行数: m.querySelectorAll('tbody tr').length, 表头: [...m.querySelectorAll('th')].map(x=>String(x.innerText||'').trim()).slice(0,10) })
})()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-goods.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-ks-goods.png')

console.log('\n=== 收尾：Esc 关弹窗 + 关抽屉 + 取消勾选 ===')
for (let i = 0; i < 3; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(900)
}
console.log(await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(b => b.checked)
  for (const b of boxes) (b.closest('label') || b).click()
  return '取消了 ' + boxes.length + ' 行勾选'
})()`))
await sleep(1500)
console.log('收尾计数:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
