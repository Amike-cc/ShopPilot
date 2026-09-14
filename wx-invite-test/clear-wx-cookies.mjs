/** 用产品自身的"清除 Cookie"把微信店铺登录数据清干净（同时验证：清 Cookie 会同步删掉会话快照） */
const fs = await import('fs')
const path = await import('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const snap = path.join(process.env.APPDATA, 'shopilot', 'stores', STORE, 'session-cookies.enc')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3500)
console.log('清理前快照存在:', fs.existsSync(snap))
console.log('清 Cookie 调用:', await ev(`(async()=>{const r=await window.shopilot.browser.clearData('${STORE}',['cookies']);return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))
await sleep(2500)
console.log('清理后快照存在:', fs.existsSync(snap), '（应为 false —— 清 Cookie 必须同步删快照）')
console.log('Cookie 查看器:', await ev(`(async()=>{const r=await window.shopilot.session.cookies('${STORE}');return JSON.stringify({total:(r.data||{}).total})})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
