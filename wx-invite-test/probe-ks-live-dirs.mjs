/**
 * 精确针对**已进入后台**的快手标签页（URL 含 tax-bill/subsidy 且不是 login 域名）探查：
 *  - 页面上有哪些疑似"开票方向/页签"
 *  - 数据表的表头与行数
 * 只读。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const cands = list.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian') && !x.url.includes('login.kwaixiaodian'))
console.log('候选标签页:', cands.length)
for (const c of cands) console.log('  -', c.url.slice(0, 120))
const pg = cands[0]
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

console.log('\n视口:', await q(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
console.log('正文片段:', String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 400)`)))

console.log('\n=== 疑似方向/页签元素 ===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of all) {
    const t = own(el).trim()
    if (!t || t.length > 16) continue
    if (!/开票|发票|账单|补贴|平台|买家|佣金|申请|明细/.test(t)) continue
    const r = el.getBoundingClientRect()
    const k = t + '|' + el.tagName + '|' + String(el.className||'').slice(0,30)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,44) + '> ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' y=' + Math.round(r.top))
  }
  return out.join('\\n')
})()`))

console.log('\n=== 表格 ===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(e => e.tagName === 'TABLE')
  return JSON.stringify(tables.map((t, i) => ({
    第几张: i,
    表头: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean),
    行数: t.querySelectorAll('tbody tr').length,
    前2行: [...t.querySelectorAll('tbody tr')].slice(0,2).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26)))
  })), null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
