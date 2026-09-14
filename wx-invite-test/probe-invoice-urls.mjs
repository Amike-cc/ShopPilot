/**
 * 实测各平台后台的「发票」入口：打开平台首页，在整页（含 ShadowRoot）里找含「发票」的
 * 链接/菜单项，打印其 href 与可点击元素信息。不猜测 URL，只用页面上真实存在的东西。
 * 用法：node probe-invoice-urls.mjs [平台名，省略=全部已开店铺]
 */
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
console.log('店铺:', JSON.stringify(stores, null, 1))

const filter = process.argv[2]
const targets = filter ? stores.filter(x => x.name.includes(filter) || x.platform.includes(filter)) : stores

const SEARCH = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = []
  for (const el of all) {
    const t = own(el)
    if (!t || !/发票/.test(t) || t.length > 40) continue
    const r = el.getBoundingClientRect()
    const a = el.closest('a')
    hits.push({
      文案: t.slice(0, 24),
      tag: el.tagName,
      href: a ? String(a.getAttribute('href') || '') : null,
      可见: r.width > 0 && r.height > 0,
      最近a内的href: a ? String(a.href || '').slice(0, 140) : null,
      父级class: String((el.parentElement && el.parentElement.className) || '').slice(0, 60)
    })
  }
  // 去重
  const seen = new Set(); const out = []
  for (const h of hits) { const k = h.文案 + '|' + h.href + '|' + h.tag; if (seen.has(k)) continue; seen.add(k); out.push(h) }
  return JSON.stringify(out.slice(0, 25), null, 1)
})()`

for (const st of targets) {
  console.log(`\n===== ${st.name}（${st.platform}）=====`)
  await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
  await sleep(4000)
  const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
  let tabId = (tabs[0] || {}).id
  if (!tabId) {
    tabId = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${st.id}','about:blank');return JSON.stringify(r.data&&(r.data.tabId||r.data.id))})()`))
  }
  console.log('标签页:', JSON.stringify(tabs.map(t => t.u.slice(0, 60))))
  // 先回平台首页（发票入口通常在左侧导航或资金/结算里）
  const home = await ev(`(async()=>{const r=await window.shopilot.platforms.find(p=>p.name===${JSON.stringify(st.platform)});return r?r.adminUrl:''})()`)
  console.log('平台首页:', home)
  if (!home) { console.log('（该平台无内置首页地址，跳过）'); continue }
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(home)});return 1})()`)
  await sleep(11000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http'))
  const target = pages.find(x => x.url.includes(new URL(home).hostname))
  if (!target) { console.log('（页面没出来）'); continue }
  const w2 = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  console.log('当前页:', String(target.url).slice(0, 90))
  console.log('含「发票」的元素:', await q2(SEARCH))
  w2.close()
}
ws.close()
setTimeout(() => process.exit(0), 300)
