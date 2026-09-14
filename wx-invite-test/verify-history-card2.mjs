/** 用「点击店铺卡片」走真实交互路径（openStore 会设 displayedStoreId），再查面板历史卡片 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 点微信店铺卡片（真实交互）
console.log('点店铺卡片:', await ev(`(() => {
  const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes('微信小店测试'))
  if (!c) return 'no-card'
  c.click()
  return 'clicked'
})()`))
await sleep(4000)
console.log('displayed 卡片:', await ev(`(() => { const c = document.querySelector('.store-card.displayed'); return c ? String(c.innerText||'').replace(/\\s+/g,' ').slice(0,40) : '(无)' })()`))
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2500)
const cards = JSON.parse(await ev(`(() => {
  const cs = [...document.querySelectorAll('[data-test=invite-history-card]')]
  return JSON.stringify({ 卡片数: cs.length, 含产物验证: cs.some(c => String(c.innerText||'').includes('产物验证')), 样例: cs.slice(0,3).map(c => String(c.innerText||'').replace(/\\s+/g,' ').slice(0, 70)) })
})()`))
console.log('面板历史:', JSON.stringify(cards, null, 1))
console.log(cards.含产物验证 ? '\n✓ 面板历史正确收录（此前为 0 是测试时面板没显示该店铺）' : '\n✗ 仍未收录')
ws.close()
setTimeout(() => process.exit(0), 300)
