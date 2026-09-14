/**
 * 诊断两处采集缺陷：
 *  A) 拼多多：表头读到了但数据行为 0 → 看它的表是否分 thead/tbody、结构是否被 pickByHeader 选错
 *  B) 微信：表头为空 → 看 pickByHeader('账单号') 是否没选中（shadow 内多表）
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

async function inspect(storeKw, urlPart, pick) {
  const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
  const st = stores.find(x => x.name.includes(storeKw) || x.platform.includes(storeKw))
  console.log(`\n===== ${st.name}（${st.platform}）=====`)
  await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
  await sleep(4000)
  await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1400,height:900});return 1})()`)
  await sleep(1000)
  const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
  const tabId = (tabs[0] || {}).id
  await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}',${JSON.stringify(urlPart)});return 1})()`)
  await sleep(15000)
  const host = (() => { try { return new URL(urlPart).hostname } catch { return '' } })()
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes(host))
  const pg = pages[pages.length - 1]
  const w2 = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q2 = async (expr) => {
    const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
  }
  console.log(await q2(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const tables = all.filter(el => el.tagName === 'TABLE')
    const hit = tables.find(t => String(t.innerText||'').includes(${JSON.stringify(pick)}))
    const probe = (t) => t ? {
      tr合计: t.querySelectorAll('tr').length,
      直接tr: t.children.length,
      theadTr: t.querySelector('thead') ? t.querySelector('thead').querySelectorAll('tr').length : 0,
      tbodyTr: t.querySelector('tbody') ? t.querySelector('tbody').querySelectorAll('tr').length : 0,
      // readTable 的实现：querySelectorAll('tr')（含 thead/tbody 全部）
      首行: [...t.querySelectorAll('tr')].slice(0,3).map(tr => [...tr.children].map(c=>String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20)))
    } : null
    // 也模拟 readTable 的取法（deep 枚举后的顺序）
    return JSON.stringify({
      table总数: tables.length,
      含pick的表index: tables.indexOf(hit),
      命中表: probe(hit),
      全部表概要: tables.map((t,i) => ({ i, tr: t.querySelectorAll('tr').length, 含pick: String(t.innerText||'').includes(${JSON.stringify(pick)}) }))
    }, null, 1)
  })()`))
  w2.close()
}
await inspect('慕么美', 'https://mms.pinduoduo.com/invoice/center', '订单号')
await inspect('微信小店测试', 'https://store.weixin.qq.com/shop/bill/home', '账单号')
ws.close()
setTimeout(() => process.exit(0), 300)
