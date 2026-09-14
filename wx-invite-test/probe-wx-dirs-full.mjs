/**
 * 微信发票中心：用 JS 点击（el.click + 祖先）逐方向切换，等足够久后完整 dump 表头+数据行+汇总。
 * 目的：确认「给平台开票」「给买家开票」是否真有各自的数据、以及抓取要选哪个方向。
 * 只读，不做任何开票操作。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.platform.includes('微信'))
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(4500)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1500,height:1000});return 1})()`)
await sleep(1200)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
const tabId = (tabs[0] || {}).id
await ev(`(async()=>{await window.shopilot.browser.navigate('${st.id}','${tabId}','https://store.weixin.qq.com/shop/bill/home');return 1})()`)
await sleep(17000)
const pg = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('bill/home')).pop()
const w2 = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => {
  const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 220) : r.result?.value
}

const SNAP = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const tables = all.filter(e => e.tagName === 'TABLE')
  // 选"行数最多"的表作为数据表（日历表行数多但没有中文字段）
  const withTh = tables.map(t => ({ t, ths: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean) }))
    .filter(x => x.ths.some(h => /账单|金额|状态|单号/.test(h)))
  withTh.sort((a,b) => b.ths.length - a.ths.length)
  const pick = withTh[0]
  const rows = pick ? [...pick.t.querySelectorAll('tbody tr')].slice(0, 3).map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g, ' ').trim().slice(0, 26))) : []
  const body = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  return JSON.stringify({
    表头: pick ? pick.ths : [],
    数据行数: pick ? pick.t.querySelectorAll('tbody tr').length : 0,
    前3行: rows,
    汇总片段: (body.match(/(可开票|已开票|待开票|已申请|处理中|已完成)[^一-龥]{0,14}/g) || []).slice(0, 8)
  })
})()`

async function jsClick(label) {
  return await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const cands = all.filter(el => own(el) === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0)
    if (!cands.length) return 'no-el'
    let n = cands[0]
    const done = []
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
    return JSON.stringify(done)
  })()`)
}

const results = {}
for (const dir of ['给平台开票', '给买家开票', '申请平台开票', '收佣金发票']) {
  const c = await jsClick(dir)
  await sleep(10000)
  const snap = await q2(SNAP)
  results[dir] = JSON.parse(snap)
  console.log(`\n===== 「${dir}」（JS点击 ${c}）=====`)
  console.log('  表头:', JSON.stringify(results[dir].表头))
  console.log('  行数:', results[dir].数据行数)
  console.log('  前3行:', JSON.stringify(results[dir].前3行))
  console.log('  汇总:', JSON.stringify(results[dir].汇总片段))
}
fs.writeFileSync('wx-invite-test/wx-dirs-full.json', JSON.stringify(results, null, 1))
console.log('\n（结果已存 wx-invite-test/wx-dirs-full.json）')
w2.close(); ws.close()
setTimeout(() => process.exit(0), 300)
