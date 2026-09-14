/**
 * 打开指定店铺的发票页并 dump 结构（用于实测锚点）
 * 用法：node open-and-dump.mjs <店铺名关键字> <发票页url> [urlMarker]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2]; const target = process.argv[3]; const marker = process.argv[4] || ''
if (!kw || !target) { console.log('用法: node open-and-dump.mjs <店铺名> <url> [marker]'); process.exit(1) }

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
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.name.includes(kw) || x.platform.includes(kw))
if (!st) { console.log('没找到店铺:', kw); process.exit(1) }
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
console.log(`店铺 ${st.name}（${st.platform}）→ 导航到 ${target}`)
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(target)});return 1})()`)
await sleep(14000)

const host = (() => { try { return new URL(target).hostname } catch { return '' } })()
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes(host))
const pg = pages[pages.length - 1]
if (!pg) { console.log('页面没出来'); process.exit(1) }
console.log('落地 URL:', String(pg.url).slice(0, 120))
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250)
  return r.result?.value
}

console.log('\n=== 结构 ===')
console.log(await q2(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const tables = all.filter(el => el.tagName === 'TABLE')
  const states = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 14) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    if (/待|已|全部|申请|开票|发票|审核|可开/.test(t)) states.push(t)
  }
  return JSON.stringify({
    标题: document.title,
    微应用数: document.querySelectorAll('micro-app').length,
    table数: tables.length,
    table表头: tables.map(t => [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim())),
    表列头th合计: [...new Set(all.filter(el => el.tagName === 'TH').map(el => String(el.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean))].slice(0, 40),
    状态文案: [...new Set(states)].slice(0, 40),
    按钮: [...new Set(all.filter(el => /^(BUTTON|A)$/.test(el.tagName) && el.getBoundingClientRect().width > 0).map(el => String(el.innerText||'').replace(/\\s+/g,' ').trim()).filter(t => t && t.length <= 16))].slice(0, 30)
  }, null, 1)
})()`))

console.log('\n=== 表格数据行（前 6）===')
console.log(await q2(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(el => el.tagName === 'TABLE')
  const real = tables.map(t => [...t.querySelectorAll('tr')]).sort((a,b) => b.length - a.length)[0] || []
  return JSON.stringify(real.slice(0, 6).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 34))), null, 1)
})()`))

console.log('\n=== 页面主文本（前 900 字）===')
console.log(await q2(`(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const t = all.map(own).filter(Boolean).join(' | ')
  return JSON.stringify(t.slice(0, 900))
})()`))
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
