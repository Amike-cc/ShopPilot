/**
 * 关键实验：店铺视图**已摘除**（innerWidth=0，发票中心弹层打开中）时，
 * 用 JS 多级点击（元素 + 3 层祖先）切换「给平台开票」，对方数据还会不会加载出来？
 * 结论决定修法：JS 点击够用 → 引擎在无落点视口时降级为 JS 点击；
 *           不够用（微应用按可见性懒加载）→ 必须让运行期的视图挂载起来。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('bill/home')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

const SNAP = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(e => e.tagName === 'TABLE')
  const withTh = tables.map(t => ({ t, ths: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean) }))
    .filter(x => x.ths.some(h => /账单|金额|状态|单号/.test(h)))
  withTh.sort((a,b) => b.ths.length - a.ths.length)
  const pick = withTh[0]
  return JSON.stringify({
    视口: innerWidth + 'x' + innerHeight,
    可见性: document.visibilityState,
    表头: pick ? pick.ths : [],
    行数: pick ? pick.t.querySelectorAll('tbody tr').length : 0,
    前2行: pick ? [...pick.t.querySelectorAll('tbody tr')].slice(0,2).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30))) : []
  })
})()`

console.log('点击前:', await q(SNAP))
const r = await q(`(() => {
  const all = []
  const walk = (rr) => { for (const el of rr.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => own(el) === '给平台开票' && el.getBoundingClientRect().width > 0)
  if (!cands.length) return 'no-el'
  let n = cands[0]; const done = []
  for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName + '.' + String(n.className||'').slice(0,24)) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`)
console.log('\nJS 多级点击:', r)
for (const wait of [3000, 5000, 7000]) {
  await sleep(wait === 3000 ? 3000 : 2000)
  console.log(`\n点击后 ${wait / 1000}s:`, await q(SNAP))
}
ws.close()
setTimeout(() => process.exit(0), 200)
