/**
 * 快手「带货邀约」抽屉：商品弹窗 + 必填/禁用状态（只读，绝不点发送）。
 * 勾 2 行开抽屉 → 记录发送按钮状态 → 点「选择商品」看弹窗 → 关掉收尾。
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const click = (t) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const c = all.filter(el => own(el) === ${JSON.stringify(t)} && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a,b) => own(a).length - own(b).length)
  let n = c[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`)

// 开抽屉：勾 2 行
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await click('批量邀约')
await sleep(5000)
console.log('抽屉已开:', await q(`!!([...document.querySelectorAll('[class*=drawer]')].find(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 }))`))

console.log('\n=== A. 必填标记（带红星/required 的字段）===')
console.log(await q(`(() => {
  const d = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })[0]
  if (!d) return '(没开)'
  const out = []
  for (const el of d.querySelectorAll('label, [class*=required], [class*=Require]')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 20) continue
    if (!(el.getBoundingClientRect().width > 0)) continue
    const cls = String(el.className||'')
    out.push(t + '  <' + el.tagName + '> cls=' + cls.slice(0,60))
  }
  return [...new Set(out)].slice(0, 16).join('\\n') || '(无)'
})()`))

console.log('\n=== B. 「发送邀请」按钮：未选商品时是否禁用 ===')
console.log(await q(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => String(x.innerText||'').replace(/\\s+/g,'').trim() === '发送邀请')
  if (!b) return 'no-button'
  const cs = getComputedStyle(b)
  return JSON.stringify({ cls: String(b.className||'').slice(0,80), disabled: b.disabled, aria: b.getAttribute('aria-disabled'), 背景: cs.backgroundColor, color: cs.color, opacity: cs.opacity, cursor: cs.cursor })
})()`))

console.log('\n=== C. 带货描述框 ===')
console.log(await q(`JSON.stringify([...document.querySelectorAll('textarea')].filter(t=>t.getBoundingClientRect().width>0).map(t => ({ ph: t.placeholder||'', maxlength: t.maxLength, cls: String(t.className||'').slice(0,60) })), null, 1)`))

console.log('\n=== D. 合作标签可选项 ===')
console.log(await q(`(() => {
  const d = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })[0]
  if (!d) return '(没开)'
  const out = []
  for (const el of d.querySelectorAll('label, [class*=checkbox], [class*=tag]')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 14) continue
    if (!(el.getBoundingClientRect().width > 0)) continue
    const inp = el.querySelector ? el.querySelector('input[type=checkbox]') : null
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '> checked=' + (inp ? inp.checked : 'n/a'))
  }
  return [...new Set(out)].slice(0, 16).join('\\n') || '(无)'
})()`))

console.log('\n=== E. 点「选择商品」→ 弹窗结构 ===')
console.log('点击结果:', await click('选择商品'))
await sleep(5000)
console.log(await q(`(() => {
  const ms = [...document.querySelectorAll('[class*=modal], [class*=Modal], [role=dialog]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.display!=='none' && r.width>300 && r.height>150 })
  if (!ms.length) {
    // 回退：找固定定位的大容器
    const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && r.zIndex && parseInt(cs.zIndex,10)>=1000 })
    return fx.length ? JSON.stringify(fx.map(e=>({cls:String(e.className||'').slice(0,60), w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height), 文本:String(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300)})).slice(0,4), null, 1) : '(没有可见弹窗)'
  }
  const m = ms[ms.length-1]
  return JSON.stringify({ cls: String(m.className||'').slice(0,70), w: Math.round(m.getBoundingClientRect().width), h: Math.round(m.getBoundingClientRect().height), 文本: String(m.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 600) }, null, 1)
})()`))

console.log('\n=== F. 弹窗内表格/复选框/按钮 ===')
console.log(await q(`(() => {
  // 最上层固定浮层里找表
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 })
  if (!fx.length) return '(无浮层)'
  const top = fx[fx.length-1]
  const tables = [...top.querySelectorAll('table')]
  const out = tables.map(t => ({
    表头: [...t.querySelectorAll('th')].map(x=>String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,12),
    行数: t.querySelectorAll('tbody tr').length,
    首行: (t.querySelector('tbody tr') ? [...t.querySelector('tbody tr').children].map(c=>String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,22)) : [])
  }))
  const btns = [...top.querySelectorAll('button')].map(b => String(b.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 12)
  return JSON.stringify({ 表: out, 复选框: top.querySelectorAll('input[type=checkbox]').length, 按钮: btns }, null, 1)
})()`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-goods-modal.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-goods-modal.png')

console.log('\n=== 收尾：关弹窗/抽屉 + 清勾选 ===')
for (let i = 0; i < 3; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}
console.log(await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return '取消 ' + bs.length })()`))
await sleep(1200)
console.log('收尾:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
