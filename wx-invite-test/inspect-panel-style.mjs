/** 检查邀约面板选中态 chip 的计算样式（对比度是否可读），以及面板高度构成 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
console.log('选中态 chip 的计算样式:', await ev(`(() => {
  const chips = [...document.querySelectorAll('[data-test=invite-panel] .inv-chip')]
  const on = chips.filter(c => c.classList.contains('on'))
  const off = chips.find(c => !c.classList.contains('on'))
  const pick = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { text: String(el.innerText||'').trim().slice(0,12), color: cs.color, bg: cs.backgroundColor, border: cs.borderColor, weight: cs.fontWeight } }
  return JSON.stringify({ 总芯片: chips.length, 选中: on.length, 选中样例: on.slice(0,3).map(pick), 未选中样例: pick(off) }, null, 1)
})()`))
console.log('\n面板高度构成（各卡片）:', await ev(`(() => {
  const p = document.querySelector('[data-test=invite-panel]')
  const cards = [...p.querySelectorAll('.inv-card')]
  const notes = [...p.querySelectorAll('.env-note')]
  return JSON.stringify({
    面板总高: Math.round(p.getBoundingClientRect().height),
    卡片: cards.map(c => ({ h: Math.round(c.getBoundingClientRect().height), 标题: String((c.querySelector('.inv-card-h')||{}).innerText||'').trim().slice(0,20) })),
    说明段总高: notes.reduce((a, n) => a + n.getBoundingClientRect().height, 0).toFixed(0),
    说明段数: notes.length,
    最长说明: Math.max(...notes.map(n => Math.round(n.getBoundingClientRect().height)))
  }, null, 1)
})()`))
console.log('\n类目区占比:', await ev(`(() => {
  const p = document.querySelector('[data-test=invite-panel]')
  const chipGroups = [...p.querySelectorAll('.inv-chips')]
  const cat = chipGroups.find(g => g.querySelectorAll('.inv-chip').length > 10)
  return JSON.stringify({ 类目芯片数: cat ? cat.querySelectorAll('.inv-chip').length : 0, 类目区高度: cat ? Math.round(cat.getBoundingClientRect().height) : 0, 行数估算: cat ? Math.round(cat.getBoundingClientRect().height / 25) : 0 })
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
