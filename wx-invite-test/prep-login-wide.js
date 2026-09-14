/** 把店铺窗口视口拉宽（避免窄视口导致平台页面重叠）并截图登录二维码 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('显示店铺窗口:', await ev(`(async()=>{const r=await window.shopilot.browser.display('${STORE}');return r.ok})()`))
await new Promise(r => setTimeout(r, 1500))
console.log('拉宽视口:', await ev(`(async()=>{const r=await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return JSON.stringify(r.ok)})()`))
await new Promise(r => setTimeout(r, 2500))
ws.close()

// 截图登录页
const all = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const login = all.find(x => x.type === 'page' && String(x.url).startsWith('https://store.weixin.qq.com'))
if (login) {
  const w2 = new WebSocket(login.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const v = await snd('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,qr:!!document.querySelector("img[src*=qrcode],canvas")})', returnByValue: true })
  console.log('登录页:', v.result?.value)
  const shot = await snd('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('wx-invite-test/wx-login-front.png', Buffer.from(shot.data, 'base64'))
  console.log('截图已存 wx-invite-test/wx-login-front.png')
  w2.close()
}
setTimeout(() => process.exit(0), 300)
