/**
 * 决定性探针：点「发送邀请」到底怎样才生效？
 *  A. JS 逐级 click → 观察 60s：抽屉是否关闭、是否出现二次确认框
 *  B. 若 A 无效，改用**真实鼠标点击**（引擎 mode:'real' 的方式）→ 再观察 60s
 * 把观察窗内的变化如实打印。
 * 注意：这会真的发出邀约（用户已授权快手真实发送）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(2500)

// 打开快手店铺 + 达人广场页
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
await sleep(15000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
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
const st = () => q(`(() => {
  const drawer = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })
  const modals = [...document.querySelectorAll('[class*=modal],[class*=Modal],[role=dialog]')].filter(e => { const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>200 && r.height>80 && cs.display!=='none' })
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.replace(/\\s+/g,'')==='发送邀请')
  const r2 = btn ? btn.getBoundingClientRect() : null
  return JSON.stringify({ drawer: drawer.length, modals: modals.length, 发送邀请按钮: r2 ? { w: Math.round(r2.width), h: Math.round(r2.height), disabled: btn.disabled } : null })
})()`)
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/' + n, Buffer.from(r.data, 'base64')) }

// 准备：勾 2 行 → 开抽屉 → 填表单
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2200)
await jsClickText('批量邀约'); await sleep(6000)
await q(`(() => {
  const set=(sel,v)=>{const el=document.querySelector(sel);if(!el)return false;const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value')?.set;d?d.call(el,v):(el.value=v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true}
  set('input[placeholder*="常用联系人称呼"]','刘涛')
  set('input[placeholder*="常用11位手机号"]','13148070563')
  set('input[placeholder*="常用微信号"]','amike688')
  set('textarea','您好，想邀请您合作带货，给专属高佣与免费寄样。')
  return 1
})()`)
await sleep(1500)
console.log('准备完成:', await st())

console.log('\n=== A. JS 逐级点击「发送邀请」 ===')
console.log('点击:', await jsClickText('发送邀请'))
for (const w of [3, 10, 20]) { await sleep(w === 3 ? 3000 : 7000); console.log(`  +${w}s →`, await st()) }
await shot('ks-send-afters-js.png')

console.log('\n=== B. 真实鼠标点击「发送邀请」 ===')
const b = await q(`(() => {
  const btn = [...document.querySelectorAll('button')].find(x => x.innerText.replace(/\\s+/g,'')==='发送邀请')
  if (!btn) return null
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), disabled: btn.disabled })
})()`)
console.log('按钮:', b)
if (b) {
  const { x, y } = JSON.parse(b)
  await realClick(x, y)
  console.log('  真实点击已发')
  for (const w of [3, 10, 20, 40]) { await sleep(w === 3 ? 3000 : (w === 40 ? 20000 : 7000)); console.log(`  +${w}s →`, await st()) }
}
await shot('ks-send-afters-real.png')
console.log('\n截图: ks-send-afters-js.png / ks-send-afters-real.png')
ws.close()
setTimeout(() => process.exit(0), 300)
