/** 只重载渲染进程（不重启应用，保住店铺登录态），然后等界面就绪 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
if (!page) { console.log('没有找到渲染进程页面'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
await send('Page.enable')
console.log('重载渲染进程…')
await send('Page.reload', { ignoreCache: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  const r = await send('Runtime.evaluate', { expression: `(() => !!document.querySelector('.store-card'))()`, returnByValue: true }).catch(() => null)
  if (r && r.result && r.result.value === true) { console.log(`界面就绪（${i + 1}s）`); break }
}
const hash = await send('Runtime.evaluate', { expression: `document.querySelector('script[type=module]') ? document.querySelector('script[type=module]').src.split('/').pop() : 'unknown'`, returnByValue: true })
console.log('加载的渲染包:', hash.result && hash.result.value)
// 店铺窗口是否还在（主进程未重启 → 应该还在）
const r2 = await send('Runtime.evaluate', {
  expression: `(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(s=>s.name))})()`,
  returnByValue: true, awaitPromise: true, userGesture: true
})
console.log('店铺:', r2.result && r2.result.value)
setTimeout(() => process.exit(0), 300)
