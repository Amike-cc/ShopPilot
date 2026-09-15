/** 看当前商品弹窗与复选框的真实状态（弹窗是否打开、复选框几何/可见性）。 */
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
console.log('视口:', await q(`innerWidth+'x'+innerHeight`), '| 地址:', String(await q(`location.href`)).slice(-40))
console.log('\n=== modal-body 节点数 / 可见性 ===')
console.log(await q(`(() => {
  const ms = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body')]
  return ms.map((m, i) => {
    const r = m.getBoundingClientRect()
    const cs = getComputedStyle(m)
    return '#' + i + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' top=' + Math.round(r.top) + ' disp=' + cs.display + ' vis=' + cs.visibility
  }).join('\\n') || '(无 modal-body)'
})()`))
console.log('\n=== modal-body 里的复选框（几何 + checked + 祖先可见性）===')
console.log(await q(`(() => {
  const out = []
  const els = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')]
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect()
    let hidden = null
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = n.tagName + '.' + String(n.className||'').slice(0,30); break }
    }
    out.push(JSON.stringify({ i, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), checked: el.checked, 隐藏于: hidden }))
  })
  return out.slice(0, 5).join('\\n') || '(无复选框)'
})()`))
console.log('\n=== 抽屉是否还开着 / 商品计数 / 提示 ===')
console.log(await q(`(() => {
  const ta = [...document.querySelectorAll('textarea')].filter(t => t.getBoundingClientRect().width > 0).length
  const counter = (String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0] || null
  const hint = (String(document.body.innerText||'').replace(/\\s+/g,' ').match(/请选择商品/)||[])[0] || null
  return JSON.stringify({ 抽屉开着: ta > 0, counter, hint })
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
