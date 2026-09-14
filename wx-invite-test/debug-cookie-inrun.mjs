/** 同一次运行内对照：CDP 写会话级 Cookie → 立刻用 IPC 读（隔离 restore 的问题） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function appEv() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
}

async function main() {
  const app = await appEv()
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(3000)
  console.log('① 读分区 Cookie（当前）:', await app.ev(`(async()=>{const r=await window.shopilot.session.cookies('${STORE}');const a=(r.data&&r.data.cookies)||[];return JSON.stringify({total:a.length,names:a.slice(0,8).map(c=>c.name+'@'+c.host)})})()`))

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const pg = list.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com')) || list.find(x => x.type === 'page' && x.url.includes('127.0.0.1:8895'))
  if (!pg) { console.log('没有可用于写 cookie 的店铺页面'); return }
  console.log('用页面:', String(pg.url).slice(0, 60))
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  await send('Network.enable')
  const stamp = String(Date.now())
  console.log('② CDP 写会话级 Cookie:', JSON.stringify(await send('Network.setCookie', { name: 'sp_inrun', value: stamp, domain: 'shopilot-probe.test', path: '/', secure: true })))
  await sleep(1200)
  console.log('③ 立刻 IPC 读:', await app.ev(`(async()=>{const r=await window.shopilot.session.cookies('${STORE}');const a=(r.data&&r.data.cookies)||[];const p=a.filter(c=>c.name==='sp_inrun');return JSON.stringify({total:a.length,probe:p.map(c=>({v:c.value,session:!c.expirationDate}))})})()`))
  console.log('④ CDP 读（同页面）:', JSON.stringify(await send('Network.getCookies', { urls: ['https://shopilot-probe.test/'] })))
  ws.close()
  app.close()
}

main().then(() => setTimeout(() => process.exit(0), 300)).catch(e => { console.error('ERR', e.message); process.exit(1) })
