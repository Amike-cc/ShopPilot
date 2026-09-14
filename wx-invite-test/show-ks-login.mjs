/**
 * 收尾：关掉渲染层弹层（弹层开着会把店铺原生视图摘除，页面看不到也扫不了码），
 * 显示快手店铺并截图，确认二维码可见。只读，不点业务按钮。
 */
const fs = await import('fs')
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

// 关掉所有会摘除原生视图的弹层
const opened = JSON.parse(await ev(`JSON.stringify({
  invoice: !!document.querySelector('[data-test=invoice-center-modal]'),
  dc: !!document.querySelector('[data-test=data-center-modal]')
})`))
console.log('打开的弹层:', JSON.stringify(opened))
await ev(`(() => {
  const m = document.querySelector('[data-test=invoice-center-modal]')
  if (m) {
    const btns = [...m.querySelectorAll('button')]
    const close = btns.find(b => /关闭/.test(String(b.innerText||''))) || btns[btns.length-1]
    if (close) close.click()
  }
  return 1
})()`)
await sleep(1500)

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1440,height:940});return 1})()`)
await sleep(2000)
console.log('显示店铺:', ks.name)

const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = l2.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
if (!pg) { console.log('没找到快手页面'); process.exit(1) }
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
}
console.log('页面地址:', await q2(`location.href.slice(0,90)`))
console.log('视口:', await q2(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
const shot = await snd('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-login-fresh.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-ks-login-fresh.png')
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
