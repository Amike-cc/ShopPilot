/**
 * 拼多多发票相关页面探索：从后台首页点进各发票入口，看有没有「给平台开票」方向。
 * 只读（不点任何开票/提交按钮）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('mms.pinduoduo.com')).pop()
if (!pg) { console.log('没有拼多多页面'); process.exit(1) }
console.log('目标页面:', pg.url, '\n')
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}

// 找「发票管理」菜单并点开，dump 展开后的子项
console.log('=== 点开侧栏「发票管理」菜单 ===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => own(el).includes('发票管理'))
  if (!cands.length) return 'no-menu'
  let n = cands[0]; const done = []
  for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`))
await sleep(2500)
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of all) {
    const t = own(el).trim()
    if (!t || t.length > 16) continue
    if (!/开票|发票/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const k = t
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '> y=' + Math.round(r.top))
  }
  return out.join('\\n')
})()`))

// 导航到常见候选地址，看是否命中「给平台开票」
for (const u of ['https://mms.pinduoduo.com/invoice/platform', 'https://mms.pinduoduo.com/invoice/subsidy', 'https://mms.pinduoduo.com/cashier/finance/invoice', 'https://mms.pinduoduo.com/invoice/list']) {
  const r = await q(`(async()=>{ location.href = ${JSON.stringify(u)}; return 1 })()`)
  await sleep(6000)
  const info = await q(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const tables = all.filter(e => e.tagName === 'TABLE')
    const heads = tables.map(t => [...t.querySelectorAll('th')].map(x => String(x.innerText||'').trim()).filter(Boolean))
    return JSON.stringify({ url: location.pathname, 正文片段: String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 160), 表头: heads })
  })()`)
  console.log('\n--- 试地址', u)
  console.log('   ', info)
}
ws.close()
setTimeout(() => process.exit(0), 200)
