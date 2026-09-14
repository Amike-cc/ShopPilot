/**
 * 深挖微信发票中心的**数据表**（跳过日历表格）：打印每个 table 的表头与数据行，
 * 以及"可开票"页签下真实的行内容 —— 用于确定要抓哪些列。
 * 用法：node probe-wx-invoice-table.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('/shop/bill/home'))
if (!page) { console.log('没有发票中心页面'); process.exit(0) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

console.log('=== 每个 table 的表头 + 前 3 行 ===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(el => el.tagName === 'TABLE')
  return JSON.stringify(tables.map((t, i) => ({
    i,
    ths: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()),
    行数: t.querySelectorAll('tr').length,
    前3行: [...t.querySelectorAll('tr')].slice(0, 3).map(tr => [...tr.querySelectorAll('td')].map(td => String(td.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 30)))
  })), null, 1)
})()`))

console.log('\n=== 全页所有含「¥」或金额样式的文本（可开金额候选）===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 24) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (/^[¥￥]?[\\d,]+\\.?\\d*$/.test(t)) out.push(t)
  }
  return JSON.stringify([...new Set(out)].slice(0, 40))
})()`))

console.log('\n=== 页签区（可开票/已开票/开票记录）的可点元素 ===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/^(可开票|已开票|开票记录|申请平台开票|给买家开票|给平台开票|收佣金发票)$/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const cls = String(el.className || '') + ' | ' + String((el.parentElement && el.parentElement.className) || '')
    out.push({ t, tag: el.tagName, cls: cls.slice(0, 80), 选中: /(current|active|selected)/i.test(cls) })
  }
  return JSON.stringify(out, null, 1)
})()`))

console.log('\n=== 当前「可开票」视图下的完整文本（前 1200 字）===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // 找发票中心微应用的主容器文本
  const host = document.querySelector('micro-app')
  const root = host && host.shadowRoot
  if (!root) return 'no shadowRoot'
  const txt = []
  const w2 = (r) => { for (const el of r.querySelectorAll('*')) { const t = own(el); if (t) txt.push(t); if (el.shadowRoot) w2(el.shadowRoot) } }
  w2(root)
  return JSON.stringify(txt.filter(t => t.length < 200).join(' | ').slice(0, 1200), null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
