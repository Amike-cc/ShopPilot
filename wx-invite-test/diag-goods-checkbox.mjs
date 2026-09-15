/** 诊断：快手商品弹窗里复选框的可见性/几何（引擎要求 width>0 且 opacity!=0）。 */
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(13000)
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await q(`(() => { const all=[...document.querySelectorAll('*')]; const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim(); const c=all.filter(el=>own(el).includes('批量邀约')&&el.getBoundingClientRect().width>0); c.sort((a,b)=>own(a).length-own(b).length); let n=c[0]; for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click()}catch{}} return 1 })()`)
await sleep(5000)
// 打开商品弹窗
await q(`(() => { const all=[...document.querySelectorAll('*')]; const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim(); const c=all.filter(el=>own(el).includes('选择商品')&&el.getBoundingClientRect().width>0); c.sort((a,b)=>own(a).length-own(b).length); let n=c[0]; for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click()}catch{}} return 1 })()`)
await sleep(5000)

const SEL = process.argv[2] || '.kwaishop-cps-daren-match-pc-modal-body'
console.log('用容器:', SEL)
console.log('\n=== 行数 ===')
console.log(await q(`document.querySelectorAll(${JSON.stringify(SEL + ' tbody tr')}).length`))
console.log('\n=== input[type=checkbox] 的可见性与几何 ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll(${JSON.stringify(SEL + ' tbody input[type=checkbox]')})) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    out.push(JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), disp: cs.display, vis: cs.visibility, op: cs.opacity, checked: el.checked, cls: String(el.className||'').slice(0,44) }))
  }
  return out.join('\\n') || '(无匹配)'
})()`))
console.log('\n=== 同区域的 label（可点的那个） ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll(${JSON.stringify(SEL + ' tbody label')})) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    out.push(JSON.stringify({ cls: String(el.className||'').slice(0,50), w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity, hasInput: !!el.querySelector('input[type=checkbox]'), checked: (el.querySelector('input[type=checkbox]')||{}).checked }))
  }
  return out.join('\\n') || '(无 label)'
})()`))
console.log('\n=== [class*=checkbox-wrapper] 类 ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll(${JSON.stringify(SEL + ' [class*=checkbox-wrapper]')})) {
    const r = el.getBoundingClientRect()
    out.push(JSON.stringify({ cls: String(el.className||'').slice(0,50), tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height) }))
  }
  return out.join('\\n') || '(无)'
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
