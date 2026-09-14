/**
 * 重启后自检：微信店铺登录态是否还在 + 广场页是否可用（不发送任何东西）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function appPage() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  if (!t) throw new Error('no app page')
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
  return {
    ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value,
    close: () => ws.close()
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function wsPage(urlPart, budgetMs = 40000) {
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
        return {
          url: t.url,
          ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value,
          close: () => ws.close()
        }
      }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1500)
  }
}

async function main() {
  const app = await appPage()
  const stores = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(s=>({id:s.id,name:s.name,platform:s.platform})))})()`))
  console.log('店铺：', JSON.stringify(stores))
  const wx = stores.find(s => String(s.platform).includes('微信')) || stores[0]
  if (!wx) throw new Error('没有店铺')
  console.log('目标店铺：', wx.name, wx.id)
  await app.ev(`(async()=>{await window.shopilot.browser.open('${wx.id}');return 1})()`)
  await sleep(5000)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1500)
  // 把当前标签页开到广场
  const tabs = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${wx.id}');return JSON.stringify((r.data.tabs||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,80)})))})()`))
  console.log('标签页：', JSON.stringify(tabs))
  const active = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${wx.id}');return JSON.stringify({id:(r.data&&r.data.activeTabId)||null})})()`))
  const tabId = active.id || (tabs[0] && tabs[0].id)
  console.log('用标签页：', tabId)
  await app.ev(`(async()=>{await window.shopilot.browser.navigate('${wx.id}','${tabId}','https://store.weixin.qq.com/shop/findersquare/find');return 1})()`)
  await sleep(8000)
  const sq = await wsPage('findersquare/find')
  if (!sq) { console.log('广场页没出来'); process.exit(1) }
  console.log('页面地址：', sq.url.slice(0, 120))
  console.log(await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    return JSON.stringify({
      loginExpired: /登录超时|请重新登录|扫码/.test(txt),
      hasQR: !!document.querySelector('img[src*=qrcode], canvas, .login-qrcode'),
      detailCount: all.filter(el => own(el) === '详情').length,
      head: txt.slice(0, 160)
    })
  })()`))
  console.log('额度文本:', await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const hit = all.map(el => String(el.innerText || '')).find(t => /今日剩余/.test(t) && t.length < 60)
    return hit ? hit.replace(/\\s+/g, ' ').slice(0, 80) : '未找到额度文本'
  })()`))
  sq.close()
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
