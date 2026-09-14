/** 打开微信小店登录页（用店铺标签页导航过去）并截图二维码 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const fs = require('fs')
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function pickLive(urlPart) {
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
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return {
          send,
          ev: async (expr) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
            return res.result?.value
          },
          close: () => ws.close()
        }
      }
    } catch { /* next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(3500)
  const tabs = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(r.data.tabs||[])})()`))
  console.log('tabs:', tabs.map(t => ({ id: t.id, url: String(t.url || '').slice(0, 50) })))
  const tabId = (tabs[0] || {}).id
  if (!tabId) throw new Error('no tab')
  await app.ev(`(async()=>{const r=await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/');return r.ok})()`)
  app.close()
  await sleep(9000)
  const wx = await pickLive('store.weixin.qq.com')
  if (!wx) { console.log('no weixin page'); process.exit(1) }
  const info = await wx.ev(`(function(){var qr=document.querySelector("img[src*=qrcode],img[src*=qr],canvas");return JSON.stringify({url:location.href.slice(0,60),hasQR:!!qr,text:String(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,80)})})()`)
  console.log('login page:', info)
  const shot = await wx.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('wx-invite-test/wx-login-qr.png', Buffer.from(shot.data, 'base64'))
  console.log('saved wx-invite-test/wx-login-qr.png')
  wx.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
