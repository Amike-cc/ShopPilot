/**
 * 定位 IPC cookies.get({}) 返回 0 的原因：
 *   对比 (a) cookies.get({}) 无参、(b) cookies.get({domain}) 、(c) cookies.get({url}) 三种读法
 *   并打印 session 身份（分区名）确认是同一个 session。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
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
await sleep(2500)

// 渲染层能拿到多少条（IPC 视角）
console.log('IPC cookies:', await ev(`(async()=>{const r=await window.shopilot.session.cookies('${STORE}');const a=(r.data&&r.data.cookies)||[];return JSON.stringify({ok:r.ok,total:a.length,sample:a.slice(0,5).map(c=>c.name+'@'+c.host)})})()`))
console.log('IPC cookies 带 search:', await ev(`(async()=>{const r=await window.shopilot.session.cookies('${STORE}','weixin');const a=(r.data&&r.data.cookies)||[];return JSON.stringify({ok:r.ok,total:a.length})})()`))

// 页面侧读（同分区）
const pg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
if (pg) {
  const w = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
  let s2 = 0; const q = new Map()
  w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id) } }
  const sn = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; q.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
  const r1 = await sn('Network.getAllCookies')
  const all = (r1.cookies || [])
  console.log('\nCDP getAllCookies 总数:', all.length)
  const byDomain = {}
  for (const c of all) byDomain[c.domain] = (byDomain[c.domain] || 0) + 1
  console.log('按域名（前 10）:', JSON.stringify(Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 10)))
  console.log('weixin 相关样本:', JSON.stringify(all.filter(c => /weixin/.test(c.domain)).slice(0, 3).map(c => ({ n: c.name, d: c.domain, session: c.session }))))
  w.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
