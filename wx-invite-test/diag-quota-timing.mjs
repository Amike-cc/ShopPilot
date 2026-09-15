/**
 * 验证 requireQuota 的时序：抽屉刚打开时「今日剩余」是否已渲染？
 * 对比 t+0.5s / t+2s / t+4s 三个时间点能否按 own-text 找到该文案。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
}
const FOUND = `(() => {
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    if (!own.includes('今日剩余')) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    return own.slice(0, 40)
  }
  return null
})()`

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(13000)
console.log('勾 2 行 + 点批量邀约，然后在多个时间点探测「今日剩余」：')
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await q(`(() => { const all=[...document.querySelectorAll('*')]; const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim(); const c=all.filter(el=>own(el).includes('批量邀约')&&el.getBoundingClientRect().width>0); if(!c.length)return 0; c.sort((a,b)=>own(a).length-own(b).length); let n=c[0]; for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click()}catch{}} return 1 })()`)
for (const t of [500, 1500, 2500, 4000, 6000]) {
  await sleep(t === 500 ? 500 : 1000)
  console.log(`  t≈${t}ms →`, await q(FOUND))
}
console.log('\n抽屉是否开着:', await q(`(() => { const d=[...document.querySelectorAll('[class*=drawer]')].filter(e=>{const cs=getComputedStyle(e);const r=e.getBoundingClientRect();return cs.position==='fixed'&&r.width>400&&r.height>200}); return d.length ? 'open' : 'closed' })()`))
console.log('textarea 是否已出现:', await q(`!!document.querySelector('textarea')`))
ws.close()
setTimeout(() => process.exit(0), 200)
