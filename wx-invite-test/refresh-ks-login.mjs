/**
 * 打开快手店铺并导航到发票页 → 被重定向到登录页时刷新二维码，截图留给用户扫。
 * 只读（不点任何业务按钮；登录由用户自己扫码完成）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const list0 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list0.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 220) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
if (!ks) { console.log('没有快手店铺'); process.exit(1) }
console.log('快手店铺:', ks.name, ks.id)

await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(4000)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1500,height:1000});return 1})()`)
await sleep(1200)

const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${ks.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
console.log('标签页:', tabs.map(t => t.u.slice(0, 70)).join(' | '))
const tabId = (tabs.find(t => t.u.includes('kwaixiaodian')) || tabs[0]).id
// 重新导航以刷新过期的二维码
await ev(`(async()=>{await window.shopilot.browser.navigate('${ks.id}','${tabId}','https://s.kwaixiaodian.com/zone/fund/tax-bill/subsidy');return 1})()`)
await sleep(9000)
await ev(`(async()=>{await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)

const after = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${ks.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
console.log('导航后:', after.map(t => t.u.slice(0, 80)).join(' | '))

// 直接截这个标签页（WebContentsView 是独立 target）
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
  console.log('页面地址:', await q2(`location.href`))
  console.log('视口:', await q2(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
  console.log('正文:', String(await q2(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`)))
  console.log('二维码元素:', await q2(`(() => {
    const out = []
    for (const sel of ['canvas','img[src*=qr]','[class*=qrcode]','[class*=qr-code]','[class*=code]']) {
      const n = document.querySelectorAll(sel).length
      if (n) out.push(sel + '×' + n)
    }
    const fresh = /过期|刷新/.test(String(document.body.innerText||''))
    return out.join(' | ') + '  含"过期/刷新"=' + fresh
  })()`))
  const shot = await snd('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('wx-invite-test/ui-ks-login-fresh.png', Buffer.from(shot.data, 'base64'))
  console.log('截图已存 wx-invite-test/ui-ks-login-fresh.png')
  w2.close()
} else {
  console.log('没找到快手页面 target')
}
ws.close()
setTimeout(() => process.exit(0), 300)
