/**
 * 读当前真实额度（只读，不发任何邀约）：
 *   新建/复用标签页 → 广场 → 点第一条「详情」（真实点击，会开新标签页）→
 *   新标签页点「邀请带货」（等 4s 稳定）→ 表单页读「今日剩余N次邀请机会」。
 * 顺便：把「我的邀约」页顶部所有短文本标签都打出来（找全状态页签）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'

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
async function page(urlPart, budgetMs = 45000, exact = null) {
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
const deepAtFn = `const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }`

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,tabs:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,60)}))})})()`)
const p = JSON.parse(raw)
console.log('现有标签页:', JSON.stringify(p.tabs))
let tabId = p.active || (p.tabs[0] && p.tabs[0].id)
if (!tabId) {
  tabId = JSON.parse(await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))
}
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${SQUARE}');return 1})()`)
await sleep(9000)

// ① 广场 → 第一条「详情」真实点击
const sq = await page('findersquare/find', 40000, '/shop/findersquare/find')
if (!sq) { console.log('广场没出来'); process.exit(1) }
const dp = JSON.parse(await sq.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  ${deepAtFn}
  for (const el of all) {
    if (own(el) !== '详情') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top > 120 && r.bottom < innerHeight)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    if (at === el || el.contains(at)) return JSON.stringify([x, y])
  }
  return 'null'
})()`))
if (!dp) { console.log('找不到未被遮挡的「详情」'); process.exit(1) }
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await sq.send('Input.dispatchMouseEvent', { type, x: dp[0], y: dp[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(70)
}
await sleep(5000)
sq.close()

// ② 详情页 → 「邀请带货」（先等稳定）
const det = await page('finder-detail', 30000)
if (!det) { console.log('详情页没出来'); process.exit(1) }
await sleep(4500)
const ip = JSON.parse(await det.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  ${deepAtFn}
  for (const el of all) {
    if (own(el) !== '邀请带货') continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.top > 60 && r.bottom < innerHeight)) continue
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const at = deepAt(x, y)
    if (at === el || el.contains(at)) return JSON.stringify([x, y])
  }
  return 'null'
})()`))
if (!ip) { console.log('找不到「邀请带货」'); process.exit(1) }
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await det.send('Input.dispatchMouseEvent', { type, x: ip[0], y: ip[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(80)
}
await sleep(6000)
console.log('详情页 URL:', await det.ev('location.href.slice(0,100)'))
det.close()

// ③ 表单页读额度
const form = await page('initiate-invite', 30000)
if (form) {
  console.log('① 今日剩余额度:', await form.ev(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const deepText = all.map(el => own(el)).filter(Boolean).join(' ')
    const m = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(deepText)
    const rows = all.filter(e => e.tagName === 'TR' && /ID\\s*\\d{6,}/.test(String(e.innerText || ''))).length
    const sendBtn = all.find(e => own(e) === '发送邀约')
    return JSON.stringify({ 今日剩余: m ? Number(m[1]) : null, 表单现有商品行: rows, 发送按钮禁用: sendBtn ? /disabled/i.test(String(sendBtn.className||'')) : null, url: location.href.slice(0,80) })
  })()`))
  form.close()
} else { console.log('表单页没出来') }

// ④ 我的邀约：把所有短文本标签打出来（找全状态页签）
const mi = await page('my-invite', 20000)
if (!mi) {
  await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
  await sleep(10000)
  const m2 = await page('my-invite', 30000, '/shop/findersquare/my-invite')
  if (m2) {
    console.log('② 我的邀约顶部标签:', await m2.ev(`(() => {
      const all = []
      const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const out = new Set()
      for (const el of all) {
        const t = own(el)
        if (!t || t.length > 16) continue
        const r = el.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0 && r.top < 340)) continue
        out.add(t)
      }
      return JSON.stringify([...out])
    })()`))
    m2.close()
  }
} else { mi.close() }

// 收尾：关掉探测用的标签页（保留一个 find 页给面板用）
const list2 = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page' && t.url.includes('store.weixin.qq.com'))
console.log('探测后残留微信页:', list2.map(t => String(t.url).slice(0, 70)))
process.exit(0)
