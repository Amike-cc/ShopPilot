/** 看「邀请中」页签的元素结构/父级/当前选中态，并用多种方式各点一次，看内容是否变 */
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

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,tabs:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
let tabId = p.active || (p.tabs && p.tabs[0])
if (!tabId) tabId = JSON.parse(await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))
// 关掉旧 my-invite 页，重新开一个干净的
const stale = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page' && t.url.includes('my-invite'))
for (const st of stale) { const id = p.tabs.find(x => x === st.id); if (id) await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {}) }
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
await sleep(12000)
const mi = await page('my-invite', 40000, '/shop/findersquare/my-invite')
if (!mi) { console.log('我的邀约页没出来'); process.exit(1) }

console.log('页签结构:', await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const el of all) {
    const t = own(el)
    if (!/^(已接受|邀请中|已失效)/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top < 340)) continue
    out.push({
      t,
      tag: el.tagName, cls: String(el.className || '').slice(0, 60),
      parentTag: el.parentElement && el.parentElement.tagName,
      parentCls: String((el.parentElement && el.parentElement.className) || '').slice(0, 60),
      grandCls: String((el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className) || '').slice(0, 60),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      textDecoration: getComputedStyle(el).textDecorationLine,
      fontWeight: getComputedStyle(el).fontWeight,
      color: getComputedStyle(el).color
    })
  }
  return JSON.stringify(out, null, 1)
})()`))

// 用 JS 点击（找「邀请中」及其祖先里最像 tab 的）
console.log('JS 点击:', await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => /^邀请中/.test(own(e)) && e.getBoundingClientRect().width > 0)
  if (!el) return 'not-found'
  let node = el, clicked = []
  for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
    clicked.push(node.tagName)
    try { node.click() } catch (e) { clicked.push('err') }
  }
  return JSON.stringify(clicked)
})()`))
await sleep(5000)
console.log('点击后前 3 行:', await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const rows = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  const deepText = all.map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()).filter(Boolean).join(' ')
  const today = (deepText.match(/2026[/-]09[/-]1[4-5][^ ]{0,6}/g) || [])
  return JSON.stringify({ 行数: rows.length, 前4行: rows.slice(0, 4), 今天日期片段: [...new Set(today)] })
})()`))

// 无论是否切换，直接全文搜今天的邀约行
console.log('全文搜今天:', await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const rows = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim())
  const today = rows.filter(t => /09[/-]1[4-5]/.test(t))
  return JSON.stringify({ 今天行数: today.length, 行: today.slice(0, 12) }, null, 1)
})()`))
mi.close()
process.exit(0)
