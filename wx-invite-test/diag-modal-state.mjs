/** 看当前商品弹窗状态：商品是否勾上、确认按钮是否可用、按钮文案原文。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const J = async u => (await fetch(u)).json()
const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('无 darren 页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
console.log('视口:', await q(`innerWidth+'x'+innerHeight`))
console.log('\n=== 商品弹窗是否可见 ===')
console.log(await q(`(() => {
  const m = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body')
  if (!m) return 'no-modal-node'
  const r = m.getBoundingClientRect(); const cs = getComputedStyle(m)
  const parent = m.closest('.kwaishop-cps-daren-match-pc-modal-wrap') || m.parentElement
  const ps = parent ? getComputedStyle(parent) : null
  const pr = parent ? parent.getBoundingClientRect() : null
  return JSON.stringify({ bodyVisible: cs.display !== 'none' && r.width > 0 && r.height > 0, bodyRect: { w: Math.round(r.width), h: Math.round(r.height) }, 父: parent ? String(parent.className||'').slice(0,50) : null, 父display: ps && ps.display, 父rect: pr ? { w: Math.round(pr.width), h: Math.round(pr.height) } : null })
})()`))
console.log('\n=== 弹窗里已勾选商品数 ===')
console.log(await q(`(() => {
  const m = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body')
  if (!m) return 'no-modal'
  const boxes = [...m.querySelectorAll('tbody input[type=checkbox]')]
  return JSON.stringify({ 总数: boxes.length, 已勾: boxes.filter(b => b.checked).length })
})()`))
console.log('\n=== 弹窗内按钮（原文 + 禁用）===')
console.log(await q(`(() => {
  const m = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body')
  if (!m) return 'no-modal'
  return [...m.querySelectorAll('button')].map(b => {
    const r = b.getBoundingClientRect()
    return JSON.stringify({ text: b.innerText, 去空格: b.innerText.replace(/\\s+/g,''), disabled: b.disabled, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 })
  }).slice(0, 12).join('\\n')
})()`))
console.log('\n=== 抽屉商品计数 ===')
console.log(await q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`))
console.log('\n=== 提示文案（请选择商品等）===')
console.log(await q(`(() => { const b=String(document.body.innerText||'').replace(/\\s+/g,' '); const ms=b.match(/(请选择[^ ]{0,8}|[^ ]{0,6}必填|不能为空)/g); return ms ? [...new Set(ms)].slice(0,6).join(' | ') : '(无)' })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
