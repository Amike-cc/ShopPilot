/**
 * 诊断：快手选完「带货类目=个护家清 / 纸品湿巾」后，「已选」标记到底长什么样、在哪个元素上。
 * 用面板同样的点击方式（clickByText 的 within={text:'带货类目',climb:2}）复现，然后 dump。
 */
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
console.log('当前地址:', pg.url)
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(13000)

// 复刻引擎的 within={text:'带货类目',climb:2} 定位 + 点击
console.log('\n=== 点「个护家清」（within=行标签上溯2层）===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const lab = all.find(el => own(el) === '带货类目' && el.getBoundingClientRect().width > 0)
  if (!lab) return 'no-label'
  let row = lab
  for (let i = 0; i < 2 && row; i++) row = row.parentElement
  if (!row) return 'no-row'
  const narrow = x => String(x).replace(/\\s+/g,'')
  const c = [...row.querySelectorAll('*')].filter(el => narrow(own(el)) === '个护家清' && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-chip'
  let n = c[0]; const done = []
  for (let i = 0; i < 3 && n && n !== row; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ chain: done })
})()`))
await sleep(3000)
console.log('下拉是否出现:', await q(`(() => {
  const d = [...document.querySelectorAll('[class*=select-dropdown]')].filter(e => e.getBoundingClientRect().height > 30)
  return d.length ? String(d[0].innerText||'').replace(/\\s+/g,' ').slice(0,120) : '(无)'
})()`))
console.log('\n=== 点叶子「纸品湿巾」 ===')
console.log(await q(`(() => {
  const d = [...document.querySelectorAll('[class*=select-dropdown]')].filter(e => e.getBoundingClientRect().height > 30).pop()
  if (!d) return 'no-dropdown'
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const items = [...d.querySelectorAll('*')].filter(el => own(el).trim() === '纸品湿巾')
  if (!items.length) return 'no-item'
  let n = items[0]; const done = []
  for (let i = 0; i < 3 && n && n !== d; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`))
await sleep(4500)

console.log('\n=== 点完后的「已选」相关 DOM ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
    if (!/^已选/.test(own) && !/^已选/.test(t)) continue
    if (t.length > 60) continue
    const r = el.getBoundingClientRect()
    const cls = String(el.className||'').slice(0,55)
    out.push('own="' + own.slice(0,30) + '" inner="' + t.slice(0,40) + '"  <' + el.tagName + '.' + cls + '> vis=' + (r.width>0) + ' tagForm=' + /result/.test(cls))
  }
  return [...new Set(out)].slice(0, 14).join('\\n') || '(没有以「已选」开头的元素)'
})()`))

console.log('\n=== 「已选1个/已选2个」标记的完整文本 ===')
console.log(await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const ms = b.match(/已选\\d+个[^ ]{0,40}/g)
  return ms ? [...new Set(ms)].slice(0,6).join('\\n') : '(无)'
})()`))

console.log('\n=== 表格是否有「主推类目/带货类目」生效文案 ===')
console.log(await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const ms = b.match(/(带货类目|个护家清)[：:][^ ]{0,30}/g)
  return ms ? [...new Set(ms)].slice(0,8).join('\\n') : '(无)'
})()`))

ws.close()
setTimeout(() => process.exit(0), 200)
