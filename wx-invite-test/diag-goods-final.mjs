/**
 * 商品弹窗决定性实测（先把店铺视图挂起来，几何才准）。
 * 步骤：读回快手标签页 → 渲染层点店铺卡（挂载视图）→ 勾 2 行 → 开抽屉 → 点选择商品
 *      → 勾一行（真实鼠标）→ 看计数 → 点确认（真实鼠标）→ 看弹窗/计数。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
const restore = () => { try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {} }

// ---- 渲染层：打开并显示快手店铺，点店铺卡让中栏上报 viewport ----
const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const aw = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { aw.onopen = ok; aw.onerror = err })
let s0 = 0; const p0 = new Map()
aw.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p0.has(m.id)) { p0.get(m.id)(m); p0.delete(m.id) } }
const asend = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s0; p0.set(id, m => m.error ? err(new Error('x')) : ok(m.result)); aw.send(JSON.stringify({ id, method: m2, params: pp })) })
const e0 = async (expr) => {
  const r = await asend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? null : r.result?.value
}
const stores = JSON.parse(await e0(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await e0(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(3000)
await e0("(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (c) c.click(); return 1 })()")
await sleep(3000)
restore(); await sleep(1500)
console.log('中栏 viewport:', await e0("(() => { const v = document.querySelector('.viewport, [class*=viewport]'); return v ? Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height) : 'none' })()"))
// 找 daren 标签页并导航过去
const tabs = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, u: String(x.url||'') }))) })()"))
let tabId = (tabs.find(t => t.u.includes('daren')) || tabs[0] || {}).id
if (!tabId) {
  const c = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.create(" + JSON.stringify(ks.id) + ", 'about:blank'); return JSON.stringify(r) })()"))
  tabId = c.data && (c.data.tabId || c.data.id)
}
await e0("(async()=>{const r=await window.shopilot.browser.navigate(" + JSON.stringify(ks.id) + ", " + JSON.stringify(tabId) + ", 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro');return 1})()")
await sleep(2000)
// **必须激活该标签页**：店铺窗口只挂载"当前活动标签页"，未激活的页视口是 0×0。
// 引擎在每轮开头会 activateTab，我这里也得照做，否则所有几何测量都失真（前面几轮就是这么被坑的）。
console.log('激活标签页:', await e0("(async()=>{const r=await window.shopilot.browser.tab.activate(" + JSON.stringify(ks.id) + ", " + JSON.stringify(tabId) + ");return JSON.stringify(r)})()"))
aw.close()
await sleep(15000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 220) : r.result?.value
}
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const jsClickText = (t) => q(`(() => {
  const all=[...document.querySelectorAll('*')]
  const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const narrow=x=>String(x).replace(/\\s+/g,'')
  const c=all.filter(el=>narrow(own(el)).includes(narrow(${JSON.stringify(t)}))&&el.getBoundingClientRect().width>0)
  if(!c.length)return 'no-el'
  c.sort((a,b)=>narrow(own(a)).length-narrow(own(b)).length)
  let n=c[0];const d=[];for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click();d.push(n.tagName)}catch{d.push('e')}}
  return JSON.stringify(d)
})()`)
const counter = () => q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`)
const modalBoxes = () => q(`(() => {
  const m = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body')
  if (!m) return 'no-modal'
  const r = m.getBoundingClientRect()
  const boxes = m.querySelectorAll('tbody input[type=checkbox]').length
  const rows = m.querySelectorAll('tbody tr').length
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), boxes, rows })
})()`)
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/' + n, Buffer.from(r.data, 'base64')) }

console.log('页面视口:', await q(`innerWidth+'x'+innerHeight`))
if ((await q(`innerWidth`)) < 50) { console.log('!! 视图仍未挂载，测量会失真，终止'); process.exit(1) }

await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2200)
await jsClickText('批量邀约'); await sleep(6000)
console.log('抽屉后: counter =', await counter())

console.log('\n① 点「选择商品」:', await jsClickText('选择商品'))
for (const w of [2, 3, 4]) { await sleep(w === 2 ? 2000 : 1000); console.log(`   +${w}s modalBody=${await modalBoxes()} counter=${await counter()}`) }
await shot('ks-g1.png')

console.log('\n② 弹窗第一个复选框几何:')
console.log(await q(`(() => {
  const el = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')
  if (!el) return '(无)'
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
  const lab = el.closest('label')
  const lr = lab ? lab.getBoundingClientRect() : null
  return JSON.stringify({ input: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity }, label: lr ? { x: Math.round(lr.left), y: Math.round(lr.top), w: Math.round(lr.width), h: Math.round(lr.height), op: getComputedStyle(lab).opacity } : null, checked: el.checked })
})()`))

console.log('\n③ 真实鼠标点复选框中心:')
const cb = await q(`(() => {
  const el = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
})()`)
if (cb) {
  const { x, y } = JSON.parse(cb)
  const before = await counter()
  await realClick(x, y)
  await sleep(2200)
  console.log(`   counter: ${before} → ${await counter()}`)
  console.log('   checked:', await q(`(() => { const el = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]'); return el ? el.checked : 'gone' })()`))
}
await shot('ks-g2.png')

console.log('\n④ 点弹窗「确 认」:')
const okb = await q(`(() => {
  const b = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body button')].find(x => x.innerText.replace(/\\s+/g,'') === '确认')
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), disabled: b.disabled })
})()`)
console.log('   按钮:', okb)
if (okb) {
  const { x, y } = JSON.parse(okb)
  await realClick(x, y)
  for (const w of [3, 6, 10]) { await sleep(3000); console.log(`   +${w}s modalBody=${await modalBoxes()} counter=${await counter()}`) }
}
await shot('ks-g3.png')
console.log('\n截图: ks-g1/2/3.png')
ws.close()
setTimeout(() => process.exit(0), 300)
