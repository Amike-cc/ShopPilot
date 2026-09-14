/**
 * 结构勘察：把某店铺后台当前页（含 ShadowRoot）的表格/列表结构 dump 出来，
 * 用于确定"需要开票的信息"有哪些列、用什么锚点读。
 * 只读，不做任何操作。用法：node dump-page-structure.mjs <url包含的关键字> [最大行数]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const urlPart = process.argv[2] || '/shop/bill/home'
const maxRows = Number(process.argv[3] || 5)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes(urlPart))
if (!page) {
  console.log('没有匹配的页面:', urlPart)
  console.log('当前页面：')
  for (const t of list.filter(x => x.type === 'page')) console.log('  ', String(t.url).slice(0, 100))
  process.exit(0)
}
console.log('页面:', String(page.url).slice(0, 110))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const deepText = all.map(own).filter(Boolean).join(' ')
  const tables = all.filter(el => el.tagName === 'TABLE')
  const ths = [...new Set(all.filter(el => el.tagName === 'TH').map(el => String(el.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean))]
  // 页签/筛选区（找"待开票/待处理/已开票"这类状态词）
  const stateWords = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 12) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (/待|已|全部|申请|开票|发票|审核/.test(t)) stateWords.push(t)
  }
  return JSON.stringify({
    页面标题: document.title,
    微应用数: document.querySelectorAll('micro-app').length,
    table数: tables.length,
    表头: ths.slice(0, 40),
    状态类文案: [...new Set(stateWords)].slice(0, 40),
    正文片段: deepText.replace(/\\s+/g, ' ').slice(0, 700)
  }, null, 1)
})()`))

console.log('\n=== 表格前几行的单元格文本 ===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const rows = all.filter(el => el.tagName === 'TR')
  const out = rows.slice(0, ${maxRows}).map(tr => [...tr.querySelectorAll('td,th')].map(td => String(td.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 40)))
  return JSON.stringify(out, null, 1)
})()`))

console.log('\n=== 页面内可见「按钮/链接」文案（可能是"申请开票/导出"等）===')
console.log(await ev(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const out = []
  for (const el of all) {
    if (!/^(BUTTON|A)$/.test(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 20) continue
    out.push(t)
  }
  return JSON.stringify([...new Set(out)].slice(0, 40))
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
