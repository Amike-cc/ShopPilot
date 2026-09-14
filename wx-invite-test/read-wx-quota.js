/** 只读：打开一个真实邀约表单页，读「今日剩余N次邀请机会」（不点任何发送） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method: m2, params: p2 }))
  })
  return { send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
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
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) return { url: t.url, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1000)
  }
}
const QUOTA = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const t = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  const m = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(t)
  return JSON.stringify({ url: location.href.slice(0, 90), 剩余额度: m ? Number(m[1]) : null, 原文: (m || [])[0] || null, 片段: t.slice(0, 100) })
})()`

// 找一个历史 initiate-invite 标签页 URL 作为模板
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const prev = list.find(x => x.type === 'page' && x.url.includes('initiate-invite'))
console.log('历史邀约页:', prev ? prev.url.slice(0, 130) : '(无)')
const finder = prev ? (/finderUsername=([A-Za-z0-9_]+)/.exec(prev.url) || [])[1] : null
console.log('finderUsername:', finder ? finder.slice(0, 40) + '…' : '(无)')
if (!finder) { console.log('没有可用的 finderUsername，跳过'); process.exit(0) }

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
const tabId = p.active || (p.first && p.first[0])
const url = `https://store.weixin.qq.com/shop/findersquare/initiate-invite?finderUsername=${finder}`
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${url}');return 1})()`)
await sleep(9000)
const pg = await page('initiate-invite')
if (!pg) { console.log('邀约表单页没出来'); process.exit(1) }
console.log(await pg.ev(QUOTA))
pg.close()
// 顺便关掉这个探测用的标签页，保持窗口干净
await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${tabId}');return 1})()`).catch(() => {})
process.exit(0)
