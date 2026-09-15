/**
 * 决定性对比：JS 点击 vs 真实鼠标点击「发送邀请」，各观察 40s，看抽屉是否关闭 / 是否弹确认框。
 * 每次对照前都重新准备一遍（勾 2 行 → 开抽屉 → 填表单），保证起点一致。
 * 用户已授权快手真实发送。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
const restore = () => { try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {} }
restore(); await sleep(2500)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('没有达人广场页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
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
/** 抽屉状态：textarea 是否还可见（这才是"抽屉关没关"的可靠判据） */
const drawerOpen = () => q(`(() => {
  const t = [...document.querySelectorAll('textarea')].filter(x => { const r = x.getBoundingClientRect(); const cs = getComputedStyle(x); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' })
  const modals = [...document.querySelectorAll('[class*=modal],[role=dialog]')].filter(e => { const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return r.width>200 && r.height>80 && cs.display!=='none' })
  const body = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const hint = (body.match(/(确认发送|确认邀请|发送成功|邀约成功|已发送|请选择[^ ]{0,10})/g)||[]).slice(0,3)
  return JSON.stringify({ 抽屉开着: t.length > 0, 弹窗数: modals.length, 提示: hint })
})()`)
const prep = async () => {
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
}

// 回到列表页重新开始
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(14000)
console.log('视口:', await q(`innerWidth+'x'+innerHeight`))

console.log('\n=== A. JS 逐级点击「发送邀请」 ===')
await prep()
console.log('  起点:', await drawerOpen())
console.log('  点击:', await jsClickText('发送邀请'))
for (const w of [3, 8, 15]) { await sleep(w === 3 ? 3000 : (w === 8 ? 5000 : 7000)); console.log(`   +${w}s →`, await drawerOpen()) }
{ const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/ks-send-js.png', Buffer.from(r.data, 'base64')) }

// 关掉抽屉（Esc）后重新准备，测真实鼠标点击
console.log('\n=== B. 真实鼠标点击「发送邀请」 ===')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(2500)
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return 1 })()`)
await sleep(1500)
await prep()
console.log('  起点:', await drawerOpen())
const b = await q(`(() => {
  const btn = [...document.querySelectorAll('button')].find(x => x.innerText.replace(/\\s+/g,'')==='发送邀请')
  if (!btn) return null
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  const at = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2))
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), disabled: btn.disabled, 落点元素: at ? at.tagName + '.' + String(at.className||'').slice(0,30) : 'null' })
})()`)
console.log('  按钮:', b)
if (b) {
  const { x, y } = JSON.parse(b)
  restore(); await sleep(1200)
  await realClick(x, y)
  console.log('  真实点击已发')
  for (const w of [3, 8, 15, 30]) { await sleep(w === 3 ? 3000 : (w === 30 ? 15000 : 5000)); console.log(`   +${w}s →`, await drawerOpen()) }
}
{ const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/ks-send-real.png', Buffer.from(r.data, 'base64')) }
console.log('\n截图: ks-send-js.png / ks-send-real.png')
ws.close()
setTimeout(() => process.exit(0), 300)
