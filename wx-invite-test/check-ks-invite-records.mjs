/** 核实快手邀约是否真的记录在案：点侧栏「合作邀约」看记录列表。 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(2000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const TARGET = process.argv[2] || '我的达人'
console.log('当前地址:', String(await q(`location.href`)).slice(0, 90))
console.log('\n=== 点侧栏「' + TARGET + '」===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const c = all.filter(el => own(el) === ${JSON.stringify(TARGET)} && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a,b) => own(a).length - own(b).length)
  let n = c[0]; const d = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); d.push(n.tagName) } catch { d.push('e') } }
  return JSON.stringify(d)
})()`))
await sleep(10000)
console.log('点后地址:', String(await q(`location.href`)).slice(0, 90))
console.log('\n=== 页面表格 ===')
console.log(await q(`(() => {
  const ts = [...document.querySelectorAll('table')]
  return ts.map((t, i) => {
    const ths = [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean)
    const rows = [...t.querySelectorAll('tbody tr')]
    return '表' + i + ' 表头=' + JSON.stringify(ths.slice(0, 12)) + ' 行数=' + rows.length + (rows[0] ? '\\n  首行=' + JSON.stringify([...rows[0].children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 26))) : '')
  }).join('\\n') || '(无表格)'
})()`))
console.log('\n=== 正文片段 ===')
console.log(String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 900)`)))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ks-invite-records.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图: wx-invite-test/ks-invite-records.png')
ws.close()
setTimeout(() => process.exit(0), 200)
