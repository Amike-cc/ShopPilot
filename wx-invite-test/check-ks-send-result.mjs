/**
 * 核实上一次「发送邀请」是否真的发出去了。
 * 线索：① 达人广场里被邀约过的达人是否变成"已邀约/不可再选"；② 合作邀约/我的达人里有没有新记录。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()
// 恢复窗口（0×0 会让页面元素测量失真）
const { execSync } = await import('child_process')
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File wx-invite-test\\win-restore.ps1', { encoding: 'utf8' }) } catch {}
await sleep(2000)

// 找店铺页，导航到「我的达人」（邀约/合作记录）
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
// 用「合作邀约」页看记录（分销后台菜单里的合作邀约）
const tabs = JSON.parse(await e0("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, u: String(x.url||'') }))) })()"))
const daren = tabs.find(t => t.u.includes('daren'))
const targetTab = (daren || tabs[0] || {}).id
console.log('用标签页:', targetTab)
// 先去「合作邀约」列表页（快手分销后台的邀约记录）
await e0("(async()=>{const r=await window.shopilot.browser.navigate(" + JSON.stringify(ks.id) + ", " + JSON.stringify(targetTab) + ", 'https://cps.kwaixiaodian.com/zone/daren-match/my-daren');return 1})()")
await sleep(14000)

const pg = (await J(`http://127.0.0.1:${PORT}/json/list`)).filter(x => x.type === 'page' && x.url.includes('kwaixiaodian')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW' : r.result?.value
}
console.log('地址:', await q(`location.href.slice(0,80)`))
console.log('视口:', await q(`innerWidth+'x'+innerHeight`))
console.log('正文片段:', String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,600)`)))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ks-my-daren.png', Buffer.from(shot.data, 'base64'))
console.log('截图: wx-invite-test/ks-my-daren.png')
ws.close(); aw.close()
setTimeout(() => process.exit(0), 200)
