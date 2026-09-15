/**
 * 快手商品弹窗：选 1 个商品 → 确认，并把按钮原文（含空格）如实打出。
 * 另外在 JS 里搜"确认发送/确认邀请"这类弹窗文案线索（判断点发送后是否有二次确认框）。
 * 绝不点「发送邀请」。结束关弹窗/抽屉、清勾选。
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

// 开抽屉 + 商品弹窗
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await click('批量邀约'); await sleep(5000)
await click('选择商品'); await sleep(5000)

console.log('=== A. 商品弹窗按钮的**原始文本**（JSON 转义看空格）===')
console.log(await q(`(() => {
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 })
  if (!fx.length) return '(无浮层)'
  const top = fx[fx.length-1]
  return JSON.stringify([...top.querySelectorAll('button')].map(b => {
    const own = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    return { innerText: b.innerText, 自有文本: own, cls: String(b.className||'').slice(0,50) }
  }).slice(0, 14), null, 1)
})()`))

console.log('\n=== B. 搜索输入框（商品ID 路径用）===')
console.log(await q(`(() => {
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 })
  if (!fx.length) return '(无浮层)'
  const top = fx[fx.length-1]
  return JSON.stringify([...top.querySelectorAll('input, textarea')].map(i => ({ type: i.type, ph: i.placeholder||'', cls: String(i.className||'').slice(0,50) })), null, 1)
})()`))

console.log('\n=== C. 商品行与复选框 ===')
console.log(await q(`(() => {
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 })
  if (!fx.length) return '(无浮层)'
  const top = fx[fx.length-1]
  const rows = [...top.querySelectorAll('tbody tr')]
  return JSON.stringify({
    复选框总数: top.querySelectorAll('input[type=checkbox]').length,
    行数: rows.length,
    每行复选框: rows.slice(0,3).map(tr => ({ 有: !!tr.querySelector('input[type=checkbox]'), 文本: String(tr.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50) })),
    第一行label类: (rows[0] && rows[0].querySelector('label')) ? String(rows[0].querySelector('label').className||'').slice(0,50) : null
  }, null, 1)
})()`))

console.log('\n=== D. 勾选第一个商品行 + 点确认 ===')
console.log('勾选:', await q(`(() => {
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 })
  const top = fx[fx.length-1]
  const boxes = [...top.querySelectorAll('tbody input[type=checkbox]')]
  if (!boxes.length) return 'no-checkbox'
  const b = boxes[0]
  ;(b.closest('label') || b).click()
  return 'checked=' + b.checked
})()`))
await sleep(1500)
console.log('确认点击:', await click('确 认'))
await sleep(4000)
console.log('弹窗是否还在:', await q(`!!([...document.querySelectorAll('div')].find(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 && parseInt(cs.zIndex||'0',10)>=1000 }))`))
console.log('抽屉里的"已选择商品数":', await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = b.match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)
  return m ? m[0] : '(没找到)'
})()`))

console.log('\n=== E. JS 里搜"二次确认"线索 ===')
console.log(await q(`(() => {
  const out = []
  const needles = ['确认发送', '确认邀请', '确认要发送', '是否发送', '发送成功', '确认提交', '带货邀约']
  const walk = (obj, depth) => {
    if (depth > 6 || !obj) return
    try {
      for (const k of Object.keys(obj)) {
        const v = obj[k]
        if (typeof v === 'string' && needles.some(n => v.includes(n)) && v.length < 80) out.push(v)
        else if (typeof v === 'object') walk(v, depth + 1)
      }
    } catch {}
  }
  // 只扫有限深度，避免卡死
  walk(window.__INITIAL_STATE__ || {}, 0)
  return [...new Set(out)].slice(0, 12).join('\\n') || '(未从 initialState 里找到线索；发送后以"抽屉关闭"为成功判据)'
})()`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-goods-selected.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-goods-selected.png')

console.log('\n=== 收尾 ===')
for (let i = 0; i < 3; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}
console.log(await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return '取消 ' + bs.length })()`))
await sleep(1200)
console.log('收尾计数:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
