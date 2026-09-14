/** 点击「打开达人广场」后，抓 toast（用 MutationObserver 记录所有出现过的 .toast，避免轮询漏掉） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 进面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)

// 用 MutationObserver 记录所有 .toast 的出现（含文本）
console.log('装观察器:', await ev(`(() => {
  window.__toasts = []
  const scan = () => {
    for (const e of document.querySelectorAll('.toast')) {
      const t = String(e.innerText || '').trim()
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t)
    }
  }
  scan()
  const ob = new MutationObserver(scan)
  ob.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  window.__observer = ob
  return 'watching; 当前 toast 数=' + document.querySelectorAll('.toast').length
})()`))

// 确保活动页不是广场
const created = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify({id:r.data&&(r.data.tabId||r.data.id)})})()`))
if (created.id) { await ev(`(async()=>{await window.shopilot.browser.tab.activate('${STORE}','${created.id}');return 1})()`); await sleep(1500) }
console.log('点击前活动页已切到 about:blank')

const pt = JSON.parse(await ev(`(() => { const e = document.querySelector('[data-test=invite-open-page]'); const r = e.getBoundingClientRect(); return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]) })()`))
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(90)
}
await sleep(14000)
console.log('观察到的 toast:', await ev(`JSON.stringify(window.__toasts || [])`))
console.log('当前 DOM 里的 toast:', await ev(`JSON.stringify([...document.querySelectorAll('.toast')].map(e=>String(e.innerText||'').trim()))`))
console.log('toast 容器样本:', await ev(`(() => {
  const w = document.querySelector('.toast-wrap, .toasts, [class*=toast]')
  return w ? w.outerHTML.slice(0, 300) : 'no container'
})()`))
console.log('标签页:', await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'').slice(0,50)))})()`))
setTimeout(() => process.exit(0), 300)
