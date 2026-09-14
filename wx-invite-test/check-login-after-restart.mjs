/** 新建标签页 → 打开微信广场 → 检查登录态是否跨重启幸存 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
let tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
if (!tabs.length) {
  const c = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','https://store.weixin.qq.com/shop/findersquare/find');return JSON.stringify({ok:r.ok,id:r.data&&(r.data.tabId||r.data.id)})})()`))
  console.log('新建标签页:', JSON.stringify(c))
  await sleep(12000)
} else {
  console.log('已有标签页:', JSON.stringify(tabs))
}
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
await sleep(3000)
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
if (!pages.length) { console.log('没有微信页面'); process.exit(1) }
for (const p of pages.slice(0, 2)) {
  const w = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
  let s2 = 0; const q = new Map()
  w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id) } }
  const sn = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; q.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
  const r = await sn('Runtime.evaluate', {
    expression: `(() => {
      const all = []
      const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const txt = String(document.body ? document.body.innerText : '')
      return JSON.stringify({
        url: location.href.slice(0, 70),
        expired: /登录超时|请重新\\s*登录|扫码进入我的小店/.test(txt),
        详情数: all.filter(el => own(el) === '详情').length,
        已登录迹象: /店铺管理|商品管理|优选联盟/.test(txt)
      })
    })()`, returnByValue: true
  })
  console.log('页面:', r.result?.value)
  w.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
