/**
 * 复现并 dump「商品不符合达人带货要求」二次确认框的 DOM。
 * 跑到"商品弹窗点确认"为止 → 等 4s → dump 所有可见弹层/按钮/文案 + 截图。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(2000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('无 daren 页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const jsClickText = (t) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = x => String(x).replace(/\\s+/g, '')
  const c = all.filter(el => narrow(own(el)).includes(narrow(${JSON.stringify(t)})) && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a, b) => narrow(own(a)).length - narrow(own(b)).length)
  let n = c[0]; const d = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); d.push(n.tagName) } catch { d.push('e') } }
  return JSON.stringify(d)
})()`)
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('wx-invite-test/' + n, Buffer.from(r.data, 'base64')) }

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(14000)
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(1500)
console.log('视口:', await q(`innerWidth + 'x' + innerHeight`))

// 勾 2 人 → 开抽屉 → 填表单 → 选商品 → 点商品弹窗的确认
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
console.log('\n点「选择商品」:', await jsClickText('选择商品'))
await sleep(5000)
// 勾第一个商品
console.log('勾商品:', await q(`(() => {
  const b = [...document.querySelectorAll('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]')][0]
  if (!b) return 'no-box'
  ;(b.closest('label') || b).click()
  return 'checked=' + b.checked
})()`))
await sleep(1500)
console.log('商品计数:', await q(`(String(document.body.innerText||'').replace(/\\s+/g,' ').match(/已选择商品数[：:]?\\s*\\d+\\/\\d+/)||[])[0]||null`))
console.log('\n点商品弹窗的「确 认」:', await jsClickText('确认'))
await sleep(4500)

console.log('\n===== 点确认后：所有可见弹层 =====')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('div,section')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (r.width < 220 || r.height < 80) continue
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
    const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
    if (!t) continue
    out.push('z=' + (cs.zIndex || '-') + '  ' + String(el.className || '').slice(0, 58) + '  ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' y=' + Math.round(r.top) + '\\n    文本=' + t.slice(0, 90))
  }
  return out.slice(0, 10).join('\\n') || '(无可见浮层)'
})()`))
console.log('\n===== 所有可见按钮 =====')
console.log(await q(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    if (r.width <= 0 || r.height <= 0 || cs.visibility === 'hidden') continue
    const chain = []
    let n = b
    for (let i = 0; i < 5 && n; i++, n = n.parentElement) chain.push(String(n.className || '').split(' ')[0].slice(0, 30))
    out.push('"' + b.innerText.replace(/\\s+/g, '') + '"  y=' + Math.round(r.top) + '  ' + chain.join(' < '))
  }
  return out.slice(0, 14).join('\\n') || '(无)'
})()`))
console.log('\n===== 抽屉是否还在 =====')
console.log(await q(`JSON.stringify({ textarea可见: [...document.querySelectorAll('textarea')].filter(t=>t.getBoundingClientRect().width>0).length })`))
await shot('ks-dialog-after-confirm.png')
console.log('\n截图: ks-dialog-after-confirm.png')
ws.close()
setTimeout(() => process.exit(0), 300)
