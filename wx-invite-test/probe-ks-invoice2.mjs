/** 再试一组快手候选（带 zone 前缀），并在页面里搜「发票」文本 */
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
const st = stores.find(x => x.platform.includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
// 先回首页（清掉上一轮探测残留）
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://s.kwaixiaodian.com/zone/home');return 1})()`)
await sleep(9000)

const cands = [
  'https://s.kwaixiaodian.com/zone/fund/invoice',
  'https://s.kwaixiaodian.com/zone/fund/invoice-manage',
  'https://s.kwaixiaodian.com/zone/finance/invoice',
  'https://s.kwaixiaodian.com/zone/fund/account',
  'https://s.kwaixiaodian.com/zone/fund/settlement'
]
for (const url of cands) {
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(url)});return 1})()`)
  await sleep(8000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
  const pg = pages[pages.length - 1]
  if (!pg) { console.log(`${url} → 无页面`); continue }
  const w3 = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w3.onopen = ok; w3.onerror = err })
  let s3 = 0; const p3 = new Map()
  w3.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p3.has(m.id)) { p3.get(m.id)(m); p3.delete(m.id) } }
  const snd3 = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s3; p3.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w3.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q3 = async (expr) => (await snd3('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  console.log(`${url}\n   → ${await q3(`(() => { const t = String(document.body?document.body.innerText:'').replace(/\\s+/g,' '); return JSON.stringify({ final: location.href.slice(0,95), 含发票: /发票/.test(t), 主区文案: t.slice(0,110) }) })()`)}`)
  w3.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
