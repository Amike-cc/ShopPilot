/** 读广场当前页码（确认翻页真的发生了） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.find(x => x.type === 'page' && x.url.includes('findersquare/find') && !x.url.includes('finder-detail'))
if (!pg) { console.log('没有广场页'); process.exit(0) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cur = all.filter(e => /^\\d+$/.test(own(e)) && /(current|active|selected)/i.test(String(e.className || ''))).map(own)
  // 页码区附近的数字（判断当前高亮哪个）
  const pagerNums = all.filter(e => /^\\d+$/.test(own(e)) && e.getBoundingClientRect().width > 0).map(e => ({ n: own(e), cls: String(e.className || '').slice(0, 40) }))
  const details = all.filter(e => own(e) === '详情' && e.getBoundingClientRect().width > 0).length
  return JSON.stringify({ 当前页码高亮: cur, 页码按钮: pagerNums.slice(0, 10), 详情数: details }, null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
