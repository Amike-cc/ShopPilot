/** 诊断：抽屉底部的「今日剩余100条发送邀请机会」DOM 结构——数字在哪个元素里。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('没有达人广场页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(13000)
// 勾 2 行 + 开抽屉
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await q(`(() => { const all=[...document.querySelectorAll('*')]; const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim(); const c=all.filter(el=>own(el).includes('批量邀约')&&el.getBoundingClientRect().width>0); if(!c.length)return 0; c.sort((a,b)=>own(a).length-own(b).length); let n=c[0]; for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click()}catch{}} return 1 })()`)
await sleep(5000)

console.log('=== 含「今日剩余」的元素（own vs inner）===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const it = String(el.innerText || '').replace(/\\s+/g,' ').trim()
    if (!own.includes('今日剩余') && !it.includes('今日剩余')) continue
    if (it.length > 40) continue
    out.push('own="' + own.slice(0,30) + '" inner="' + it.slice(0,32) + '" <' + el.tagName + '.' + String(el.className||'').slice(0,36) + '>')
  }
  return [...new Set(out)].slice(0,12).join('\\n') || '(没找到)'
})()`))

console.log('\n=== 抽屉底部区域的文字 ===')
console.log(await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = b.match(/今日剩余[^ ]{0,30}/)
  return m ? m[0] : '(无)'
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
