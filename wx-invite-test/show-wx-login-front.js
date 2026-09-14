/** 把店铺窗口切到微信店铺 + 激活登录页标签页（让二维码显示在最前面），再截图确认 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const fs = await import('fs')
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('显示店铺窗口:', await ev(`(async()=>{const r=await window.shopilot.browser.display('${STORE}');return r.ok})()`))
await sleep(1500)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify((r.data.tabs||[]).map(x=>({id:x.id,url:String(x.url||'')})))})()`))
const loginTab = tabs.find(x => x.url === 'https://store.weixin.qq.com/' || x.url.startsWith('https://store.weixin.qq.com/?') || x.url === 'https://store.weixin.qq.com')
console.log('登录页标签:', JSON.stringify(loginTab))
if (loginTab) {
  console.log('激活:', await ev(`(async()=>{const r=await window.shopilot.browser.tab.activate('${STORE}','${loginTab.id}');return r.ok})()`))
  await sleep(2500)
}
// 截图登录页，确认二维码在屏幕上
for (const p of list.filter(x => x.type === 'page' && x.url.startsWith('https://store.weixin.qq.com'))) {
  const w2 = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0
  const pend2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend2.has(m.id)) { pend2.get(m.id)(m); pend2.delete(m.id) } }
  const snd = (method, params = {}) => new Promise((ok, err) => {
    const id = ++s2
    pend2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    w2.send(JSON.stringify({ id, method, params }))
  })
  const v = await snd('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,txt:String(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,40)})', returnByValue: true })
  const shot = await snd('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('wx-invite-test/wx-login-front.png', Buffer.from(shot.data, 'base64'))
  console.log('当前前台页:', p.url.slice(0, 60), v.result?.value)
  w2.close()
  break
}
ws.close()
process.exit(0)
