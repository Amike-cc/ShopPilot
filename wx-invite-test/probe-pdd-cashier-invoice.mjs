/**
 * 拼多多「资金中心 → 发票管理」（/cashier/finance/invoice）里的「给平台开票」方向探查。
 * 页面有 申请发票 / 申请记录 / 提交发票 / 提交记录 四个入口 → 逐个点开看表头与行数。
 * 只读（不点任何申请/提交类按钮，只点左侧导航查看列表）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('mms.pinduoduo.com')).pop()
if (!pg) { console.log('没有拼多多页面'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
await q(`location.href='https://mms.pinduoduo.com/cashier/finance/invoice'`)
await sleep(9000)
console.log('当前地址:', await q(`location.href`))

const SNAP = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(e => e.tagName === 'TABLE')
  const info = tables.map(t => {
    const ths = [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean)
    return { ths, rows: t.querySelectorAll('tbody tr').length,
      前2行: [...t.querySelectorAll('tbody tr')].slice(0,2).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,24))) }
  })
  return JSON.stringify({ 表数: tables.length, 表: info, 正文片段: String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 300) })
})()`

for (const dir of ['申请发票', '申请记录', '提交发票', '提交记录']) {
  const c = await q(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const cands = all.filter(el => own(el) === ${JSON.stringify(dir)} && el.getBoundingClientRect().width > 0)
    if (!cands.length) return 'no-el'
    let n = cands[0]; const done = []
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
    return JSON.stringify(done)
  })()`)
  await sleep(8000)
  console.log(`\n===== 「${dir}」（点击 ${c}）=====`)
  console.log(await q(SNAP))
}
ws.close()
setTimeout(() => process.exit(0), 200)
