/** 直接调 prepareInviteSquare，打印原始返回 + 前后标签页 URL（定位「打开达人广场」失效） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const URLS = 'https://store.weixin.qq.com/shop/findersquare/find'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300)
  return r.result.value
}
const tabs = () => ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,75)})))})()`)

console.log('调用前标签页:', await tabs())
console.log('\n→ 直接调 prepareInviteSquare（类型=直播带货者，类目=母婴，其他=有联系方式）')
const res = await ev(`(async()=>{try{const r=await window.shopilot.browser.prepareInviteSquare('${STORE}',{url:${JSON.stringify(URLS)},finderType:'直播带货者',categories:['母婴'],otherFilters:['有联系方式']});return JSON.stringify(r).slice(0,600)}catch(e){return 'THREW '+e.message}})()`)
console.log('返回:', res)
await new Promise(r => setTimeout(r, 9000))
console.log('\n调用后标签页:', await tabs())
ws.close()
process.exit(0)
