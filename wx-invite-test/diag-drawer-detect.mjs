/**
 * 关键确认：当前页面上到底有没有抽屉？textarea 是否存在（可见/隐藏）？
 * 用多个判据交叉验证，避免又是我自己的探针判据写错。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
await sleep(2000)

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
console.log('视口:', await q(`innerWidth + 'x' + innerHeight`))
console.log('\n=== 所有含 drawer 的 class 全名 ===')
console.log(await q(`(() => {
  const s = new Set()
  for (const el of document.querySelectorAll('*')) {
    const c = String(el.className||'')
    if (/drawer/i.test(c)) { s.add(c.slice(0,90)); if (s.size > 8) break }
  }
  return [...s].join('\\n') || '(没有任何含 drawer 的元素)'
})()`))
console.log('\n=== 所有 textarea（含隐藏）===')
console.log(await q(`JSON.stringify([...document.querySelectorAll('textarea')].map(t => {
  const r = t.getBoundingClientRect(); const cs = getComputedStyle(t)
  const drawer = t.closest('[class*=drawer]')
  return { w: Math.round(r.width), h: Math.round(r.height), disp: cs.display, vis: cs.visibility, ph: t.placeholder||'', 在drawer内: !!drawer, drawerCls: drawer ? String(drawer.className||'').slice(0,40) : null }
}), null, 1)`))
console.log('\n=== 「发送邀请」按钮在哪、父链是什么 ===')
console.log(await q(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.replace(/\\s+/g,'')==='发送邀请')
  if (!b) return '(没有发送邀请按钮)'
  const chain = []
  let n = b
  for (let i = 0; i < 8 && n; i++, n = n.parentElement) chain.push(n.tagName + '.' + String(n.className||'').split(' ')[0].slice(0,44))
  const r = b.getBoundingClientRect()
  return JSON.stringify({ rect: { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) }, disabled: b.disabled, 父链: chain }, null, 1)
})()`))
console.log('\n=== 页面是否有 fixed 定位的大浮层（抽屉本体）===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('div')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (cs.position !== 'fixed') continue
    if (r.width < 300 || r.height < 200) continue
    out.push(String(el.className||'').slice(0,70) + '  ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' z=' + cs.zIndex)
  }
  return out.slice(0,10).join('\\n') || '(无 fixed 大浮层)'
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
