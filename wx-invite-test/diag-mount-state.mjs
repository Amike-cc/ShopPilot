/** 诊断：弹层状态、原生视图挂载状态、快手登录页可见性。只读 + 调用 setViewsObscured 收尾。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

console.log('=== 渲染层弹层状态 ===')
console.log(await ev(`JSON.stringify({
  invoiceModal: !!document.querySelector('[data-test=invoice-center-modal]'),
  dataModal: !!document.querySelector('[data-test=data-center-modal]'),
  settings: !!document.querySelector('[data-test=settings-modal]'),
  createDialog: !!document.querySelector('[data-test=create-dialog]'),
  trash: !!document.querySelector('[data-test=trash-drawer]')
})`))

console.log('\n=== 店铺视图挂载状态 ===')
console.log(await ev(`(async()=>{
  try {
    const r = await window.shopilot.browser.getMountState ? await window.shopilot.browser.getMountState() : null
    return JSON.stringify(r)
  } catch(e) { return 'no ipc: ' + e.message }
})()`))

console.log('\n=== 显式请求恢复视图挂载 ===')
console.log(await ev(`(async()=>{ const r = await window.shopilot.browser.setViewsObscured(false); return JSON.stringify(r) })()`))
await sleep(2500)

const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = l2.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
if (pg) {
  const w2 = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => {
    const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    return r.exceptionDetails ? 'THREW' : r.result?.value
  }
  console.log('\n=== 快手页面 ===')
  console.log('地址:', await q2(`location.href.slice(0,80)`))
  console.log('视口:', await q2(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
  w2.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
