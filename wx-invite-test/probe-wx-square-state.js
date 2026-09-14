/**
 * 登录后广场体检（不改动任何东西、不发送）：
 * 登录态 / 今日剩余额度 / 「详情」条数 / 是否分页（翻页控件、总数文案）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  if (!t) throw new Error('app page not found')
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

async function page(urlPart, budgetMs = 60000) {
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
    await sleep(1500)
  }
}

const PROBE = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  const rows = all.filter(el => el.tagName === 'TR')
  const details = all.filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0)
  const quotaHit = all.map(el => own(el)).find(t => /^今日剩余/.test(t) && t.length < 40) || (txt.match(/今日剩余\\s*\\d+\\s*次邀请机会/) || [])[0] || null
  // 翻页控件
  const pagerWords = ['下一页', '上一页', '尾页', '首页']
  const pager = all.filter(el => pagerWords.includes(own(el))).map(el => own(el))
  const totalTexts = all.map(el => own(el)).filter(t => /^共\\s*\\d+/.test(t) || /共\\s*\\d+\\s*(条|个|位|页)/.test(t))
  const pageBtns = all.filter(el => el.tagName === 'LI' || /page|pager|pagination/i.test(String(el.className || ''))).map(el => own(el)).filter(t => /^\\d+$/.test(t))
  return JSON.stringify({
    url: location.href.slice(0, 120),
    loginExpired: /登录超时|请重新登录/.test(txt),
    textLen: txt.length,
    head: txt.slice(0, 140),
    详情可见数: details.length,
    tr行数: rows.length,
    额度文本: quotaHit,
    翻页: pager,
    共几: totalTexts.slice(0, 4),
    页码按钮: pageBtns.slice(0, 12)
  }, null, 1)
})()`

const o = await app()
const rawTabs = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(rawTabs)
const tabId = p.active || (p.first && p.first[0])
console.log('激活标签页:', tabId)
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${SQUARE}');return 1})()`)
await sleep(9000)
const sq = await page('findersquare/find')
if (!sq) { console.log('广场页没出来'); process.exit(1) }
console.log(await sq.ev(PROBE))
console.log('截图已存 ok')
sq.close()
process.exit(0)
