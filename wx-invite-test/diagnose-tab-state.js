/** 诊断：店铺窗口/标签页/活动标签页的真实状态（activeTabId 为什么是 null） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const out = []
const log = x => { out.push(x); console.log(x) }

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

log('① tab.list 原始: ' + await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({ok:r.ok, activeTabId:r.data&&r.data.activeTabId, keys:Object.keys(r.data||{}), tabs:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,60),orderIndex:t.orderIndex}))})})()`))
log('② browser.open 返回: ' + await ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return JSON.stringify(r).slice(0,200)})()`))
await sleep(4000)
log('③ 重开后 tab.list: ' + await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({activeTabId:r.data&&r.data.activeTabId, tabs:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,55)}))})})()`))
log('④ 页面当前状态: ' + await ev(`JSON.stringify({
  url: location.href.slice(0, 80),
  storeCards: document.querySelectorAll('.store-card').length,
  selectedStore: (() => { const c = document.querySelector('.store-card.on, .store-card.selected, .store-card.active'); return c ? String(c.innerText||'').slice(0,20) : null })(),
  webviewOrBlank: !!document.querySelector('webview, .browser-blank, [class*=blank]')
})`))
// 试着激活每个标签页，看 activate 的返回
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
for (const id of tabs) {
  log(`⑤ activate ${id.slice(0, 14)}… → ` + await ev(`(async()=>{try{const r=await window.shopilot.browser.tab.activate('${STORE}','${id}');return JSON.stringify(r).slice(0,160)}catch(e){return 'THREW '+e.message}})()`))
  await sleep(1200)
  log('   → 之后 activeTabId: ' + await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return String(r.data&&r.data.activeTabId)})()`))
}
const fs = await import('fs')
fs.writeFileSync('wx-invite-test/tab-state-out.txt', out.join('\n'))
setTimeout(() => process.exit(0), 300)
