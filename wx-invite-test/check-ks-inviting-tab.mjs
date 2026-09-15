/** 看「我的达人 → 邀约中」页签里有没有记录（这是邀约是否真的发出的权威判据）。 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(2000)
const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('my-daren')).pop()
const target = pg || (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
if (!target) { console.log('无快手页'); process.exit(1) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
console.log('地址:', String(await q(`location.href`)).slice(0, 80))
const snap = () => q(`(() => {
  const ts = [...document.querySelectorAll('table')]
  const info = ts.map(t => ({ ths: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').trim()).filter(Boolean), rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 40))) }))
  const body = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = body.match(/(暂无数据|共\\s*\\d+\\s*条)/g)
  return JSON.stringify({ 表: info.map(x => ({ 表头: x.ths.slice(0,6), 行数: x.rows.length, 首行: x.rows[0] || null })), 计数: m ? [...new Set(m)].slice(0,3) : null })
})()`)
for (const tab of ['邀约中', '意向达人', '收藏达人']) {
  console.log(`\n===== 点「${tab}」 ====="`)
  console.log(await q(`(() => {
    const all = [...document.querySelectorAll('*')]
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const narrow = x => String(x).replace(/\\s+/g,'')
    const c = all.filter(el => narrow(own(el)) === narrow(${JSON.stringify(tab)}) && el.getBoundingClientRect().width > 0)
    if (!c.length) return 'no-el'
    let n = c[0]; const d = []
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); d.push(n.tagName) } catch { d.push('e') } }
    return JSON.stringify(d)
  })()`))
  await sleep(6000)
  console.log(await snap())
}
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ks-my-daren-tabs.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图: wx-invite-test/ks-my-daren-tabs.png')
ws.close()
setTimeout(() => process.exit(0), 200)
