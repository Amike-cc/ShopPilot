/**
 * 商品弹窗实测：点「选择商品」→ 等弹窗 → 勾一行 → 看「已选择商品数」是否变化 → 点「确 认」→ 看弹窗是否关闭。
 * 每一步都打印状态，找出到底哪一步不生效。用户已授权。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
const restore = () => { try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {} }
restore(); await sleep(2000)

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
const modalOpen = () => q(`(() => {
  const m = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 200 && r.height > 100 && cs.display !== 'none' && cs.visibility !== 'hidden' })
  return m.length
})()`)
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/' + n, Buffer.from(r.data, 'base64')) }

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(14000)
restore(); await sleep(1500)
console.log('视口:', await q(`innerWidth+'x'+innerHeight`))

// 勾 2 行 + 开抽屉
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2200)
await jsClickText('批量邀约'); await sleep(6000)
console.log('抽屉已开; counter =', await counter(), 'modal =', await modalOpen())

console.log('\n=== ① 点「选择商品」（JS 逐级）===')
console.log('  ', await jsClickText('选择商品'))
for (const w of [2, 4, 6]) { await sleep(2000); console.log(`  +${w}s modal=${await modalOpen()} counter=${await counter()}`) }
await shot('ks-g1.png')

console.log('\n=== ② 弹窗里可见复选框（几何 + 是否在视口内）===')
console.log(await q(`(() => {
  const out = []
  const els = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')]
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    out.push(JSON.stringify({ i, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), op: cs.opacity, inView: r.top >= 0 && r.bottom <= innerHeight, checked: el.checked }))
  })
  return out.slice(0, 4).join('\\n') || '(无)'
})()`))

console.log('\n=== ③ 用真实鼠标点第一个复选框中心，看计数是否变化 ===')
const cb = await q(`(() => {
  const el = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), checked: el.checked })
})()`)
console.log('  目标:', cb)
if (cb) {
  const { x, y } = JSON.parse(cb)
  const before = await counter()
  await realClick(x, y)
  await sleep(2200)
  const after = await counter()
  console.log(`  counter: ${before} → ${after}`)
  console.log('  checked 现在:', await q(`(() => { const el = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]'); return el ? el.checked : 'gone' })()`))
  // 若没变，改点 label（可见的那层）
  if (before === after) {
    console.log('  计数没变 → 改点该行的 label')
    const lb = await q(`(() => {
      const inp = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')
      const lab = inp && inp.closest('label')
      if (!lab) return null
      lab.scrollIntoView({ block: 'center' })
      const r = lab.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
    })()`)
    if (lb) {
      const p = JSON.parse(lb)
      await realClick(p.x, p.y)
      await sleep(2200)
      console.log(`  label 点击后 counter = ${await counter()}`)
    }
  }
}
await shot('ks-g2.png')

console.log('\n=== ④ 点弹窗「确 认」（真实鼠标）===')
const okb = await q(`(() => {
  const b = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body button')].find(x => x.innerText.replace(/\\s+/g,'') === '确认')
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), disabled: b.disabled })
})()`)
console.log('  确认按钮:', okb)
if (okb) {
  const { x, y } = JSON.parse(okb)
  await realClick(x, y)
  for (const w of [3, 6, 10]) { await sleep(w === 3 ? 3000 : 3000); console.log(`  +${w}s modal=${await modalOpen()} counter=${await counter()}`) }
}
await shot('ks-g3.png')
console.log('\n截图: ks-g1.png / ks-g2.png / ks-g3.png')
ws.close()
setTimeout(() => process.exit(0), 300)
