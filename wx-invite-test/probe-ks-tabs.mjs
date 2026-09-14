/** 枚举快手发票页的所有 ant-tabs 页签（看是否除「未开票账单」外还有别的方向）。只读。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian') && !x.url.includes('login.')).pop()
if (!pg) { console.log('没有已登录的快手标签页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
console.log('地址:', pg.url)
console.log('\n=== ant-tabs 页签 ===')
console.log(await q(`(() => {
  const out = []
  document.querySelectorAll('[class*=ant-tabs-tab]').forEach(el => {
    const active = /active/.test(String(el.className||''))
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (t) out.push((active ? '[选中] ' : '[    ] ') + t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '>')
  })
  return out.join('\\n') || '(无 ant-tabs)'
})()`))
console.log('\n=== 页面上的「已开票 / 未开票」类文案 ===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of all) {
    const t = own(el).trim()
    if (!t || t.length > 20) continue
    if (!/已开票|未开票|开票记录|开票明细|发票记录/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,44) + '>')
  }
  return out.join('\\n')
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
