/**
 * 探针 v2：商品弹窗（打印每步点击结果 + 随时间观察弹窗与行数）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
// 新启动的应用没有达人广场页：先通过渲染层打开并显示快手店铺，再等页面出现
const list0 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list0.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
if (!app) { console.log('渲染层未就绪'); process.exit(1) }
{
  const w = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
  let s0 = 0; const p0 = new Map()
  w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p0.has(m.id)) { p0.get(m.id)(m); p0.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s0; p0.set(id, m => m.error ? err(new Error('x')) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
  const e0 = async (expr) => {
    const r = await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    return r.exceptionDetails ? null : r.result?.value
  }
  const stores = JSON.parse(await e0(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
  const ks = stores.find(x => String(x.platform).includes('快手'))
  console.log('打开快手店铺:', ks.name)
  await e0(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
  await sleep(3000)
  // 点店铺卡（渲染层才有 viewport）+ 建一个 daren 标签页
  await e0("(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(" + JSON.stringify(ks.name) + ")); if (c) c.click(); return 1 })()")
  await sleep(2500)
  const tabs = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, u: String(x.url||'') }))) })()"))
  let tabId = (tabs.find(t => t.u.includes('daren')) || tabs[0] || {}).id
  if (!tabId) {
    const created = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.create(" + JSON.stringify(ks.id) + ", 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'); return JSON.stringify(r) })()"))
    tabId = created.data && (created.data.tabId || created.data.id)
  }
  await e0("(async()=>{const r=await window.shopilot.browser.navigate(" + JSON.stringify(ks.id) + ", " + JSON.stringify(tabId) + ", 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro');return JSON.stringify(r)})()")
  w.close()
}
await sleep(15000)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('达人广场页没出现'); process.exit(1) }
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
/** 用受信任鼠标点文案（引擎 mode:'real' 的方式） */
const realClickText = async (text) => {
  const loc = await q(`(() => {
    const all = [...document.querySelectorAll('*')]
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const narrow = x => String(x).replace(/\\s+/g,'')
    const c = all.filter(el => narrow(own(el)).includes(narrow(${JSON.stringify(text)})) && el.getBoundingClientRect().width > 0)
    if (!c.length) return null
    c.sort((a,b) => narrow(own(a)).length - narrow(own(b)).length)
    const el = c[0]
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ tag: el.tagName, own: own(el).slice(0,16), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
  })()`)
  if (!loc) return 'NOT_FOUND'
  const { x, y, tag, own } = JSON.parse(loc)
  await realClick(x, y)
  return `${tag} own="${own}" @(${x},${y})`
}
const state = () => q(`(() => {
  const m = [...document.querySelectorAll('[class*=modal-body]')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 300 && r.height > 150 && cs.display !== 'none' })
  const rows = document.querySelectorAll('[class*=modal-body] tbody tr').length
  const boxes = [...document.querySelectorAll('[class*=modal-body] tbody input[type=checkbox]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  const counter = (String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0] || null
  return JSON.stringify({ modal: m.length, rows, boxes: boxes.length, counter })
})()`)

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(14000)
console.log('起始:', await state())

console.log('\n勾 2 行:', await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return bs.length })()`))
await sleep(2200)
console.log('点批量邀约:', await realClickText('批量邀约'))
await sleep(6000)
console.log('  抽屉后:', await state())
console.log('\n点选择商品:', await realClickText('选择商品'))
for (const w of [2000, 3000, 4000]) { await sleep(w === 2000 ? 2000 : 1000); console.log('  +', w, '→', await state()) }

const box = await q(`(() => {
  const els = [...document.querySelectorAll('[class*=modal-body] tbody input[type=checkbox]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  if (!els.length) return null
  const el = els[0]
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), checked: el.checked })
})()`)
console.log('\n第一个可见复选框:', box)
if (box) {
  const { x, y } = JSON.parse(box)
  await realClick(x, y)
  await sleep(2000)
  console.log('  点后:', await state())
  console.log('  checked:', await q(`(() => { const el = [...document.querySelectorAll('[class*=modal-body] tbody input[type=checkbox]')].filter(b=>b.getBoundingClientRect().width>0)[0]; return el ? el.checked : 'gone' })()`))
}
console.log('\n所有「确认」按钮（含坐标）:', await q(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    if (b.innerText.replace(/\\s+/g,'') !== '确认') continue
    const r = b.getBoundingClientRect()
    if (!(r.width > 0)) continue
    out.push(JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), disabled: b.disabled, inModal: !!b.closest('[class*=modal-body]') }))
  }
  return out.join('\\n') || '(无)'
})()`))
console.log('\n点确认:', await realClickText('确认'))
await sleep(3000)
console.log('  点后:', await state())
ws.close()
setTimeout(() => process.exit(0), 200)
