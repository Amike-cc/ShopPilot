/**
 * 快手发票入口：依次打开常见资金页并搜「发票」，同时 dump 页面里所有 a[href]。
 * 只读浏览，不做任何开票操作。
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.platform.includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id

async function look(url, tag) {
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(url)});return 1})()`)
  await sleep(12000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
  const pg = pages[pages.length - 1]
  if (!pg) { console.log(`[${tag}] 无页面`); return }
  const w2 = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => {
    const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    return r.exceptionDetails ? 'THREW' : r.result?.value
  }
  console.log(`\n[${tag}] ${String(pg.url).slice(0, 90)}`)
  console.log('  ' + await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const t = all.map(own).filter(Boolean).join(' ')
    const invEls = []
    for (const el of all) {
      const tx = own(el)
      if (!tx || !/发票/.test(tx) || tx.length > 24) continue
      const a = el.closest('a')
      invEls.push({ t: tx.slice(0,20), href: a ? String(a.getAttribute('href')||'') : null })
    }
    const links = [...document.querySelectorAll('a')].map(a => String(a.getAttribute('href')||'')).filter(h => /invoice|fapiao/i.test(h))
    return JSON.stringify({ 含发票: /发票/.test(t), 发票元素: invEls.slice(0,10), invoice链接: [...new Set(links)].slice(0,10), 片段: t.replace(/\\s+/g,' ').slice(0, 160) })
  })()`))
  w2.close()
}

await look('https://s.kwaixiaodian.com/zone/fund/account', '账户中心')
await look('https://syt.kwaixiaodian.com/zones/finance/account_center', '生意通-账户中心')
await look('https://s.kwaixiaodian.com/zone/home', '后台首页')
ws.close()
setTimeout(() => process.exit(0), 300)
