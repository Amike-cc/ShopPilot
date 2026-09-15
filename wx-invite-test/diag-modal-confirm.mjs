/**
 * 探针：商品弹窗里勾一行 → 点「确 认」，观察弹窗是否关闭、商品计数是否变化。
 * 用引擎同样的手法（真实鼠标点 checkbox 中心 → 真实鼠标点确认）。
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const clickByTextJS = (text) => q(`(() => {
  const all=[...document.querySelectorAll('*')]
  const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const c=all.filter(el=>own(el).includes(${JSON.stringify(text)})&&el.getBoundingClientRect().width>0)
  if(!c.length) return 'no-el'
  c.sort((a,b)=>own(a).length-own(b).length)
  let n=c[0]; const done=[]
  for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click();done.push(n.tagName)}catch{done.push('err')}}
  return JSON.stringify(done)
})()`)
const modalState = () => q(`(() => {
  const m = [...document.querySelectorAll('[class*=modal-body]')].filter(e => e.getBoundingClientRect().width > 300 && e.getBoundingClientRect().height > 150)
  const counter = (String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0] || null
  return JSON.stringify({ modalVisible: m.length > 0, modalCount: m.length, counter })
})()`)

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(13000)
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await clickByTextJS('批量邀约'); await sleep(5000)
await clickByTextJS('选择商品'); await sleep(5000)
console.log('① 弹窗打开后:', await modalState())

// 引擎那样：取第一个 input[type=checkbox] 中心，真实鼠标点
const box = await q(`(() => {
  const els = [...document.querySelectorAll('[class*=modal-body] tbody input[type=checkbox]')]
  if (!els.length) return null
  const el = els[0]
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), checked: el.checked })
})()`)
console.log('② 目标 checkbox:', box)
if (box) {
  const { x, y } = JSON.parse(box)
  await realClick(x, y)
  await sleep(1800)
  console.log('   点后 checked:', await q(`(() => { const el = document.querySelector('[class*=modal-body] tbody input[type=checkbox]'); return el ? el.checked : 'gone' })()`))
  console.log('   计数:', (await modalState()))
}

// 点「确 认」（真实鼠标）
const btn = await q(`(() => {
  const b = [...document.querySelectorAll('[class*=modal-body] button')].find(x => x.innerText.replace(/\\s+/g,'') === '确认')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), disabled: b.disabled, cls: String(b.className||'').slice(0,50) })
})()`)
console.log('③ 确认按钮:', btn)
if (btn) {
  const { x, y } = JSON.parse(btn)
  await realClick(x, y)
  await sleep(3000)
  console.log('   点后:', await modalState())
  console.log('   抽屉里的商品计数:', await q(`(() => (String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0] || null)()`))
}
ws.close()
setTimeout(() => process.exit(0), 200)
