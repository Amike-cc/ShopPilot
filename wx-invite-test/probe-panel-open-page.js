/** 只测面板「打开达人广场」按钮：打印前后标签页 URL、按钮是否存在、toast、displayedStoreId */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

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
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260)
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tabs = () => ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,72)})))})()`)

// 进入面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2000)

console.log('按钮存在:', await ev(`(!!document.querySelector('[data-test=invite-open-page]'))`))
console.log('面板当前筛选:', await ev(`(() => JSON.stringify({
  type: (document.querySelector('[data-test=invite-finder-type]')||{}).value,
  cats: [...document.querySelectorAll('[data-test^=invite-finder-category-]')].filter(e=>e.checked).map(e=>e.value),
  other: [...document.querySelectorAll('[data-test^=invite-finder-other-]')].filter(e=>e.checked).map(e=>e.value)
}))()`))
console.log('调用前标签页:', await tabs())

// 点按钮（真实派发 click）
console.log('\n点击「打开达人广场」…')
console.log('点击结果:', await ev(`(() => { const b = document.querySelector('[data-test=invite-open-page]'); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`))
for (let i = 1; i <= 6; i++) {
  await sleep(3000)
  const toasts = await ev(`JSON.stringify([...document.querySelectorAll('.toast, [class*=toast]')].map(e=>String(e.innerText||'').trim()).filter(Boolean))`)
  console.log(`  +${i * 3}s toast:`, toasts, ' 标签页:', await tabs())
}
ws.close()
process.exit(0)
