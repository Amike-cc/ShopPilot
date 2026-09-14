/** 打开微信小店登录页并截图二维码，便于用户扫码恢复登录态 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const fs = require('fs')

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
  if (!t) { console.log('no weixin page'); process.exit(0) }
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
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  // 直接导航到登录页
  await send('Page.enable')
  await send('Page.navigate', { url: 'https://store.weixin.qq.com/' })
  await sleep(8000)
  const info = await send('Runtime.evaluate', {
    expression: '(function(){var qr=document.querySelector("img[src*=qrcode],img[src*=qr],canvas");return JSON.stringify({url:location.href.slice(0,80),text:String(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,150),hasQR:!!qr})})()',
    returnByValue: true, awaitPromise: true
  })
  console.log(info.result?.value)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('wx-invite-test/wx-login-qr.png', Buffer.from(shot.data, 'base64'))
  console.log('saved wx-invite-test/wx-login-qr.png')
  ws.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
