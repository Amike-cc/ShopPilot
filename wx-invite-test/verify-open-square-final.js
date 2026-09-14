/**
 * 「打开达人广场」最终验收：读 Pinia store 的 toasts（比 DOM 可靠）+ 校验筛选真的生效。
 * 关键：先建一个空白页并激活，确保操作前活动页**不是广场**。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const out = []
const log = x => { out.push(String(x)); console.log(String(x)) }

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
const events = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') events.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 200))
}
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
await send('Runtime.enable')

// 进面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)

// 确保活动页不是广场：新建一个 about:blank 并激活
const created = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify({ok:r.ok,id:r.data&&(r.data.tabId||r.data.id)})})()`))
log('新建空白页: ' + JSON.stringify(created))
if (created.id) { await ev(`(async()=>{await window.shopilot.browser.tab.activate('${STORE}','${created.id}');return 1})()`); await sleep(1500) }
const before = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
log('点击前标签页: ' + JSON.stringify(before.map(u => u.slice(0, 55))))

log('面板筛选: ' + await ev(`JSON.stringify({
  type:(document.querySelector('[data-test=invite-finder-type]')||{}).value,
  cats:[...document.querySelectorAll('[data-test^=invite-finder-category-]')].filter(e=>e.checked).map(e=>e.value),
  other:[...document.querySelectorAll('[data-test^=invite-finder-other-]')].filter(e=>e.checked).map(e=>e.value)
})`))

// 清空 store 里的 toast，便于只观察本次
await ev(`(() => { try { const t = [...document.querySelectorAll('.toast')]; t.forEach(e => e.remove()); } catch {} return 1 })()`)

log('\n点击「打开达人广场」…')
const pt = JSON.parse(await ev(`(() => { const e = document.querySelector('[data-test=invite-open-page]'); const r = e.getBoundingClientRect(); return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]) })()`))
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  await sleep(90)
}

// 高频抓 .toast 文本 8 秒
const seen = []
for (let i = 0; i < 40; i++) {
  await sleep(200)
  const t = await ev(`JSON.stringify([...document.querySelectorAll('.toast')].map(e=>String(e.innerText||'').trim()).filter(Boolean))`)
  try { for (const x of JSON.parse(t)) if (!seen.includes(x)) seen.push(x) } catch { /* ignore */ }
}
log('捕获提示: ' + JSON.stringify(seen))
await sleep(5000)
const after = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
log('点击后标签页: ' + JSON.stringify(after.map(u => u.slice(0, 55))))
log('控制台异常: ' + JSON.stringify(events.slice(-4)))

// 广场页：筛选是否真的应用（找「已筛选」tag）
const sqT = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (sqT) {
  const w2 = new WebSocket(sqT.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  log('广场页: ' + await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    return JSON.stringify({
      expired: /登录超时/.test(txt),
      已筛选: (txt.match(/已筛选[^]{0,100}/) || [])[0] || null,
      详情数: all.filter(el => own(el) === '详情').length
    })
  })()`))
  w2.close()
}
const fs = await import('fs')
fs.writeFileSync('wx-invite-test/open-square-final.txt', out.join('\n'))
setTimeout(() => process.exit(0), 300)
