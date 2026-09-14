/** 逐个切换快手发票页的三个页签（未开票账单/处理中/处理记录），dump 表头与行数。只读。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
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
const SNAP = `(() => {
  const tables = [...document.querySelectorAll('table')]
  const info = tables.map(t => {
    const ths = [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean)
    const rows = [...t.querySelectorAll('tbody tr')]
    return { ths, 行数: rows.length,
      前2行: rows.slice(0,2).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,24))) }
  })
  const body = String(document.body.innerText||'').replace(/\\s+/g,' ')
  return JSON.stringify({ 表: info, 汇总片段: (body.match(/(合计|可开票|待开票|已开票|账单金额|共\\s*\\d+)[^一-龥]{0,16}/g)||[]).slice(0,6) })
})()`
for (const tab of ['未开票账单', '处理中', '处理记录']) {
  const c = await q(`(() => {
    const btns = [...document.querySelectorAll('.ant-tabs-tab-btn')]
    const t = btns.find(b => String(b.innerText||'').trim() === ${JSON.stringify(tab)})
    if (!t) return 'no-tab'
    let n = t, done = []
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
    return JSON.stringify(done)
  })()`)
  await sleep(7500)
  console.log(`\n===== 「${tab}」（点击 ${c}）=====`)
  console.log(await q(SNAP))
}
ws.close()
setTimeout(() => process.exit(0), 200)
