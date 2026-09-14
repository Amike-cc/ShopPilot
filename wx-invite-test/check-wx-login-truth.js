/** 探登录态真相：先看首页（普通页面）再看广场（微应用），对比是否都"登录超时" */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const APP = await (async () => {
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
})()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const rawTabs = await APP.ev(`(async()=>{try{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({ok:r.ok,activeTabId:r.data&&r.data.activeTabId,first:(r.data&&r.data.tabs||[]).map(t=>t.id)})}catch(e){return 'THREW '+e.message}})()`)
console.log('tab.list:', rawTabs)
const parsed = (() => { try { return JSON.parse(rawTabs) } catch { return {} } })()
const tabId = parsed.activeTabId || (parsed.first && parsed.first[0])
console.log('active tab', tabId)
if (!tabId) process.exit(1)
for (const url of ['https://store.weixin.qq.com/shop/home', 'https://store.weixin.qq.com/shop/findersquare/find']) {
  await APP.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','${url}');return 1})()`)
  await sleep(9000)
  const page = await (async () => {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    const t = list.find(x => x.type === 'page' && x.url.includes(url.includes('home') ? '/shop/home' : 'findersquare/find'))
    if (!t) return null
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
    const r = await send('Runtime.evaluate', { expression: `(function(){var t=String(document.body?document.body.innerText:'').replace(/\\s+/g,' ');return JSON.stringify({w:innerWidth,len:t.length,expired:/登录超时/.test(t),head:t.slice(0,110)})})()`, returnByValue: true })
    ws.close()
    return r.result?.value
  })()
  console.log(url, '→', page)
}
process.exit(0)
