/**
 * 打开快手店铺并导航到发票页，报告登录态；未登录时把二维码页截图留给用户扫。
 * 只读（不点业务按钮）。用法：node ks-check.mjs
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async (u) => (await fetch(u)).json()

const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
if (!ks) { console.log('没有快手店铺'); process.exit(1) }
console.log('快手店铺:', ks.name)

await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(3500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1440,height:940});return 1})()`)
await sleep(1500)

const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${ks.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
console.log('标签页:', tabs.map(t => t.u.slice(0, 60)).join(' | ') || '(无)')
if (tabId) {
  await ev(`(async()=>{await window.shopilot.browser.navigate('${ks.id}','${tabId}','https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy');return 1})()`)
  await sleep(11000)
}

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
if (!pg) { console.log('没找到快手页面 target'); process.exit(1) }
console.log('当前地址:', pg.url.slice(0, 110))
const loggedOut = /login\.kwaixiaodian\.com/.test(pg.url)
console.log(loggedOut ? '>>> 未登录（在登录页）' : '>>> 已进入后台')
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-login-fresh.png', Buffer.from(shot.data, 'base64'))
console.log('主窗口截图已存 wx-invite-test/ui-ks-login-fresh.png')
ws.close()
setTimeout(() => process.exit(0), 300)
