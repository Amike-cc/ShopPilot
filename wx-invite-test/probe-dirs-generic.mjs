/**
 * 通用：列出某发票页上所有"疑似开票方向"的页签文案，并逐个 JS 点击后 dump 表头/行数。
 * 用途：确认「给平台开票」「给买家开票」两个方向在各平台是否都存在、是否真有数据。
 * 只读（不点任何开票/提交按钮）。
 * 用法：node probe-dirs-generic.mjs <url子串> [方向1 方向2 ...]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const URLPART = process.argv[2]
const DIRS = process.argv.slice(3)
const sleep = ms => new Promise(r => setTimeout(r, ms))
if (!URLPART) { console.log('用法: node probe-dirs-generic.mjs <url子串> [方向...]'); process.exit(1) }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes(URLPART)).pop()
if (!pg) { console.log('没有匹配的页面:', URLPART); process.exit(1) }
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

// 枚举所有"自身文本较短、看起来像页签"的元素，帮我们找出方向名
console.log('=== 页面上疑似方向/页签的元素 ===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 14) continue
    if (!/开票|发票|账单|补贴|消费者|平台|买家|佣金|申请/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const cls = String(el.className || '').slice(0, 50)
    const k = t + '|' + cls
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t + '  <' + el.tagName + '.' + cls + '>  y=' + Math.round(r.top) + ' w=' + Math.round(r.width))
  }
  return out.join('\\n')
})()`))

const SNAP = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(e => e.tagName === 'TABLE')
  const info = tables.map(t => {
    const ths = [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean)
    const firstRow = [...t.querySelectorAll('tr')].slice(0,1).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20)))
    return { ths, firstRow, rows: t.querySelectorAll('tbody tr').length }
  })
  const data = info.filter(x => x.ths.some(h => /账单|金额|状态|单号|订单|税号|抬头/.test(h)))
  return JSON.stringify({ 表数: tables.length, 数据表: data, 全部表头: info.map(x => x.ths).filter(x => x.length) })
})()`

if (!DIRS.length) { console.log('\n(没给方向名，只 dump 当前状态)'); console.log(await q(SNAP)); }
for (const dir of DIRS) {
  const c = await q(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const cands = all.filter(el => own(el) === ${JSON.stringify(dir)} && el.getBoundingClientRect().width > 0)
    if (!cands.length) return 'no-el'
    let n = cands[0]; const done = []
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
    return JSON.stringify(done)
  })()`)
  await sleep(9000)
  console.log(`\n===== 「${dir}」（点击 ${c}）=====`)
  console.log(await q(SNAP))
}
ws.close()
setTimeout(() => process.exit(0), 200)
