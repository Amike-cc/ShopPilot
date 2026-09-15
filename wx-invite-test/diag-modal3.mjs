/**
 * 商品弹窗聚焦探针：勾一行 → 截图 → 点确认 → 截图，并把每一步的 DOM 状态打印出来。
 * 用「元素矩形中心」点，且先确认坐标在视口内（避开 y=0 那条）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

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
await sleep(2500)
const tabs = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, u: String(x.url||'') }))) })()"))
let tabId = (tabs.find(t => t.u.includes('daren')) || {}).id
if (!tabId) {
  const c = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.create(" + JSON.stringify(ks.id) + ", 'about:blank'); return JSON.stringify(r) })()"))
  tabId = c.data && (c.data.tabId || c.data.id)
}
await e0("(async()=>{const r=await window.shopilot.browser.navigate(" + JSON.stringify(ks.id) + ", " + JSON.stringify(tabId) + ", 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro');return 1})()")
aw.close()
await sleep(16000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync('wx-invite-test/' + name, Buffer.from(r.data, 'base64'))
}
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

console.log('视口:', await q(`innerWidth + 'x' + innerHeight + ' scrollY=' + Math.round(scrollY)`))
// 勾 2 行
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2200)
// 用 JS 逐级点开抽屉（与之前成功的手法一致）
const jsClick = (t) => q(`(() => {
  const all=[...document.querySelectorAll('*')]
  const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const narrow=x=>String(x).replace(/\\s+/g,'')
  const c=all.filter(el=>narrow(own(el)).includes(narrow(${JSON.stringify(t)}))&&el.getBoundingClientRect().width>0)
  if(!c.length) return 'no-el'
  c.sort((a,b)=>narrow(own(a)).length-narrow(own(b)).length)
  let n=c[0];const d=[];for(let i=0;i<3&&n;i++,n=n.parentElement){try{n.click();d.push(n.tagName)}catch{d.push('e')}}
  return JSON.stringify(d)
})()`)
console.log('开抽屉:', await jsClick('批量邀约'))
await sleep(6000)
console.log('抽屉后 counter:', await q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`))
await shot('ks-before-goods.png')

console.log('点选择商品:', await jsClick('选择商品'))
await sleep(6000)
const modalInfo = await q(`(() => {
  const cands = [...document.querySelectorAll('[class*=modal]')].map(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { cls: String(el.className||'').slice(0,60), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top), disp: cs.display, rows: el.querySelectorAll('tbody tr').length, boxes: el.querySelectorAll('tbody input[type=checkbox]').length } })
  return JSON.stringify(cands.filter(c => c.w > 200 && c.h > 100), null, 1)
})()`)
console.log('弹窗候选:\n' + modalInfo)
await shot('ks-goods-modal.png')

// 找一个**可见且在视口内**的商品复选框并真实点击
const box = await q(`(() => {
  const els = [...document.querySelectorAll('[class*=modal-body] tbody input[type=checkbox]')]
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.top < 60 || r.bottom > innerHeight - 60) continue
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), checked: el.checked, top: Math.round(r.top) })
  }
  return null
})()`)
console.log('可点复选框:', box)
if (box) {
  const { x, y } = JSON.parse(box)
  await realClick(x, y)
  await sleep(2000)
  console.log('点后 counter:', await q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`))
}

// 找 modal 里的确认按钮（矩形 + 层级）
const btn = await q(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    if (b.innerText.replace(/\\s+/g,'') !== '确认') continue
    const r = b.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push(JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), top: Math.round(r.top), cls: String(b.className||'').slice(0,44), inModal: !!b.closest('[class*=modal]') }))
  }
  return out.join('\\n') || '(无可见确认按钮)'
})()`)
console.log('确认按钮:\n' + btn)
const first = String(btn).split('\n')[0]
if (first && first.startsWith('{')) {
  const { x, y } = JSON.parse(first)
  await realClick(x, y)
  await sleep(4000)
  console.log('点确认后 modal 是否还在:', await q(`(() => { const m = [...document.querySelectorAll('[class*=modal]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 100 }); return m.length })()`))
  console.log('点确认后 counter:', await q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`))
}
await shot('ks-after-confirm.png')
console.log('截图: ks-before-goods.png / ks-goods-modal.png / ks-after-confirm.png')
ws.close()
setTimeout(() => process.exit(0), 300)
