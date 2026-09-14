/**
 * 探「是否能通过 URL 参数直接翻页」（只读，不发邀约）：
 * 依次打开 find?page=2 / find?pageNum=2 / find?p=2 / offset=20，对比首行达人是否变化。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_TEST_STORE_WX || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const BASE = 'https://store.weixin.qq.com/shop/findersquare/find'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function page(urlPart, budgetMs = 45000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
      let s = 0
      const pend = new Map()
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (method, params = {}) => new Promise((ok, err) => {
        const id = ++s
        pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
        ws.send(JSON.stringify({ id, method, params }))
      })
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return { url: t.url, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1000)
  }
}

const FIRST = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const details = all.filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0)
  const seen = new Set(); const rows = []
  for (const el of details) { const row = el.closest('tr') || el.parentElement
    const k = String((row && row.innerText) || '').replace(/\\s+/g, ' ').trim()
    if (seen.has(k)) continue; seen.add(k); rows.push(k.split(' ')[0]) }
  const activeNum = (all.find(e => /^\\d+$/.test(own(e)) && /(current|active|selected)/i.test(String(e.className||''))) || {}).innerText
  return JSON.stringify({ rows: rows.length, 当前页码: activeNum || null, 前三: rows.slice(0, 3) })
})()`

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
const tabId = p.active || (p.first && p.first[0])
console.log('标签页:', tabId)
console.log('基线（无参数）:')
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${BASE}');return 1})()`)
await sleep(9000)
let sq = await page('findersquare/find')
console.log('  ', await sq.ev(FIRST)); sq.close()
for (const q of ['page=2', 'pageNum=2', 'p=2', 'offset=20', 'pageIndex=2', 'current=2']) {
  await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${BASE}?${q}');return 1})()`)
  await sleep(8000)
  sq = await page('findersquare/find')
  if (!sq) { console.log(`  ${q}: 页面没出来`); continue }
  console.log(`  ${q}:`, await sq.ev(FIRST))
  sq.close()
}
process.exit(0)
