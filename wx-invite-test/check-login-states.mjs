/** 逐店铺检查后台登录态（只看是否出现登录/扫码页面特征） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))

for (const st of stores) {
  await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
  await sleep(3500)
  const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
  let tabId = (tabs[0] || {}).id
  if (!tabId) tabId = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${st.id}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))
  const home = await ev(`(() => { const ps = window.shopilot.platforms || []; const p = ps.find(x => x.name === ${JSON.stringify(st.platform)}); return p ? p.adminUrl : '' })()`)
  if (!home) { console.log(`${st.name}（${st.platform}）→ 无内置首页，跳过`); continue }
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(home)});return 1})()`)
  await sleep(10000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
  const t = pages.find(x => x.url.includes(new URL(home).hostname))
  if (!t) { console.log(`${st.name}（${st.platform}）→ 页面未加载`); continue }
  const w2 = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  const info = await q2(`(() => {
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const loginish = /扫码登录|登录|请登录|二维码|账号登录|手机号登录/.test(txt)
    const logged = /退出登录|我的店铺|店铺管理|商品管理|订单管理|资金结算/.test(txt)
    return JSON.stringify({ url: location.href.slice(0, 70), 疑似登录页: loginish && !logged, 有后台特征: logged, 片段: txt.slice(0, 100) })
  })()`)
  console.log(`${st.name}（${st.platform}）→ ${info}`)
  w2.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
