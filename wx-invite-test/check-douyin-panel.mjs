/** 检查抖店（batch-list）邀约面板在新样式下是否正常渲染（我只改了它的卡片头/运行条） */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const DD_STORE = process.env.SHOPILOT_DD_STORE || 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ev(`(async()=>{await window.shopilot.browser.open('${DD_STORE}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.display('${DD_STORE}');return 1})()`)
await sleep(1500)
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes('1111')); if (c) c.click(); return 1 })()`)
await sleep(3500)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2500)
console.log('抖店面板结构:', await ev(`(() => {
  const p = document.querySelector('[data-test=invite-panel]')
  if (!p) return JSON.stringify({ 面板: false })
  const steps = [...p.querySelectorAll('.inv-step')].map(e => String(e.innerText||'').trim())
  const heads = [...p.querySelectorAll('.inv-card-h')].map(e => String(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 26))
  const bar = p.querySelector('.inv-run-bar')
  return JSON.stringify({
    面板: true, 步骤圆标: steps, 卡片标题: heads,
    运行条sticky: bar ? getComputedStyle(bar).position : null,
    抖店专属控件: { 类目: !!p.querySelector('[data-test=invite-category]'), 等级: p.querySelectorAll('[data-test^=invite-level-]').length, 数量: !!p.querySelector('[data-test=invite-count]') },
    微信专属控件: { 类型: !!p.querySelector('[data-test=invite-finder-type]'), 联系人: !!p.querySelector('[data-test=invite-contact]') }
  }, null, 1)
})()`))
console.log('面板高度:', await ev(`(() => { const p = document.querySelector('[data-test=invite-panel]'); return Math.round(p.getBoundingClientRect().height) })()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-invite-douyin.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-invite-douyin.png')
// 切回微信店铺，避免影响后续
ws.close()
setTimeout(() => process.exit(0), 300)
