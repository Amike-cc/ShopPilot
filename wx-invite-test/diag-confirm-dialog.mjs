/**
 * 探查"商品不符合达人带货要求"二次确认框的 DOM 结构（页面上若还留着就直接 dump）。
 * 目的：确定如何在它内部安全地定位「确认」按钮（避免点到下面那一层弹窗的同名按钮）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const J = async u => (await fetch(u)).json()
const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('无 daren 页'); process.exit(1) }
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
console.log('\n=== 含「不符合」文案的元素及其上溯链 ===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const out = []
  for (const el of all) {
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
    if (!/不符合达人带货要求|确认是否仍要发送邀请/.test(t)) continue
    if (t.length > 80) continue
    const chain = []
    let n = el
    for (let i = 0; i < 7 && n; i++, n = n.parentElement) chain.push(n.tagName + '.' + String(n.className || '').split(' ')[0].slice(0, 40))
    out.push('自文本="' + ([...el.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join('').trim()).slice(0, 40) + '"\\n  文本="' + t.slice(0, 60) + '"\\n  链: ' + chain.join(' → '))
  }
  return [...new Set(out)].slice(0, 4).join('\\n\\n') || '(页面上没有这个文案——已经是别的状态了)'
})()`))
console.log('\n=== 当前所有可见「确认」按钮 + 父链 ===')
console.log(await q(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    if (b.innerText.replace(/\\s+/g, '') !== '确认') continue
    const r = b.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const chain = []
    let n = b
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) chain.push(n.tagName + '.' + String(n.className || '').split(' ')[0].slice(0, 36))
    out.push('y=' + Math.round(r.top) + '  链: ' + chain.join(' → '))
  }
  return out.join('\\n') || '(无可见确认按钮)'
})()`))
console.log('\n=== 最上层浮层（含 z-index） ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('div')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
    if (r.width < 250 || r.height < 100) continue
    out.push((cs.zIndex || '-') + '  ' + String(el.className || '').slice(0, 60) + '  ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' y=' + Math.round(r.top))
  }
  return [...new Set(out)].slice(0, 12).join('\\n') || '(无)'
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
