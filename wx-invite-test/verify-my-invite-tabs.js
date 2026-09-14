/**
 * 「我的邀约」核对：列出全部状态页签（含计数）→ 逐个点开 → 统计每页行数、今天的邀约条数与达人名。
 * 只读，不发任何邀约。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function page(urlPart, budgetMs = 40000, exact = null) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
      if (exact) { let pn = ''; try { pn = new URL(t.url).pathname } catch { continue } if (pn !== exact) continue }
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
      let s = 0
      const pend = new Map()
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) return { url: t.url, send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1200)
  }
}

const READ_TABS = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!/^(全部|待确认|已接受|已拒绝|已过期|已失效)(\\(|（)?\\d*/.test(t) || t.length > 14) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push({ t, point: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })
  }
  return JSON.stringify(out.slice(0, 20))
})()`

const READ_ROWS = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const rows = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  const body = rows.slice(1)
  const today = body.filter(t => /2026[/-]0?9[/-]1[4-5]/.test(t))
  return JSON.stringify({ 数据行: body.length, 今天的行: today, 前3行: body.slice(0, 3) })
})()`

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId, tabs:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
let tabId = p.active || (p.tabs && p.tabs[0])
if (!tabId) {
  const c = JSON.parse(await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))
  tabId = c
}
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
await sleep(12000)
const mi = await page('my-invite', 40000, '/shop/findersquare/my-invite')
if (!mi) { console.log('我的邀约页没出来'); process.exit(1) }
const tabs = JSON.parse(await mi.ev(READ_TABS))
console.log('状态页签:', JSON.stringify(tabs))
console.log('默认视图:', await mi.ev(READ_ROWS))
// 逐个点开每个页签看今天的新邀约
const seen = []
for (const tb of tabs) {
  const realclick = async (pt) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await mi.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
      await sleep(70)
    }
  }
  await realclick(tb.point)
  await sleep(3000)
  const r = JSON.parse(await mi.ev(READ_ROWS))
  console.log(`  页签「${tb.t}」→`, JSON.stringify(r))
  if (r.今天的行 && r.今天的行.length) seen.push({ tab: tb.t, rows: r.今天的行 })
}
console.log('=== 今天新增的邀约 ===')
if (!seen.length) console.log('（没有 2026/09/14-15 的行）')
for (const s of seen) { console.log(`[${s.tab}] ${s.rows.length} 条`); for (const r of s.rows) console.log('   ', r.slice(0, 80)) }
mi.close()
await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${tabId}');return 1})()`).catch(() => {})
process.exit(0)
