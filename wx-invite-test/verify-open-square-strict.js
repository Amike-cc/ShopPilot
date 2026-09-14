/**
 * 「打开达人广场」按钮的严格测试：
 *   先把活动标签页切到「我的邀约」（确保不是广场）→ 点按钮 → 立刻高频轮询 toast 与标签页 →
 *   确认：活动页变成广场、且筛选真的应用（页面上出现「已筛选」）。
 */
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tabState = () => ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');const d=r.data||{};const act=(d.tabs||[]).find(x=>x.id===d.activeTabId);return JSON.stringify({activeId:d.activeTabId,activeUrl:act?String(act.url).slice(0,70):null,count:(d.tabs||[]).length})})()`)

// 进入面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2000)

// 找一个非广场的标签页并激活（优先「我的邀约」）
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'')})))})()`))
const other = tabs.find(x => !x.url.includes('findersquare/find')) || tabs[0]
console.log('候选活动页:', JSON.stringify({ id: other.id, url: other.url.slice(0, 60) }))
await ev(`(async()=>{await window.shopilot.browser.tab.activate('${STORE}','${other.id}');return 1})()`)
await sleep(1500)
console.log('点击前:', await tabState())
console.log('面板筛选:', await ev(`JSON.stringify({
  type:(document.querySelector('[data-test=invite-finder-type]')||{}).value,
  cats:[...document.querySelectorAll('[data-test^=invite-finder-category-]')].filter(e=>e.checked).map(e=>e.value),
  other:[...document.querySelectorAll('[data-test^=invite-finder-other-]')].filter(e=>e.checked).map(e=>e.value)
})`))

console.log('\n点击「打开达人广场」…')
await ev(`(() => { document.querySelector('[data-test=invite-open-page]').click(); return 1 })()`)
// 高频轮询 toast（前 6 秒）
let toastSeen = []
for (let i = 0; i < 20; i++) {
  await sleep(300)
  const tt = await ev(`JSON.stringify([...document.querySelectorAll('[class*=toast],[class*=notice],[class*=tip],[role=alert]')].map(e=>String(e.innerText||'').trim()).filter(Boolean))`)
  try { const arr = JSON.parse(tt); if (arr.length) for (const x of arr) if (!toastSeen.includes(x)) toastSeen.push(x) } catch { /* ignore */ }
}
console.log('捕获到的提示:', JSON.stringify(toastSeen))
await sleep(6000)
console.log('点击后:', await tabState())

// 在广场页读筛选应用情况
const sq = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (sq) {
  const w2 = new WebSocket(sq.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  console.log('广场页筛选证据:', await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    return JSON.stringify({
      expired: /登录超时/.test(txt),
      已筛选片段: (txt.match(/已筛选[^]{0,90}/) || [])[0] || null,
      选中标签: [...new Set(all.map(el => {
        const p = el.parentElement
        const cls = String((p && p.className) || '') + ' ' + String(el.className || '')
        const t = own(el)
        return (t && t.length < 20 && /(current|active|checked|selected)/i.test(cls)) ? t : null
      }).filter(Boolean))].slice(0, 12),
      详情数: all.filter(el => own(el) === '详情').length
    })
  })()`))
  w2.close()
} else console.log('广场页没找到')
setTimeout(() => process.exit(0), 300)
