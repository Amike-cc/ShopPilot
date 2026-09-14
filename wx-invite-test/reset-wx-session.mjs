/**
 * 清理微信店铺的**会话 Cookie 与快照**，让下次登录从干净状态开始。
 * 背景：修复前产生的快照里，host-only Cookie 被错误地存成了域 Cookie；这些脏数据会一直被恢复。
 * 用法：node reset-wx-session.mjs
 */
const fs = await import('fs')
const path = await import('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ① 删掉快照文件
const snap = path.join(process.env.APPDATA, 'shopilot', 'stores', STORE, 'session-cookies.enc')
if (fs.existsSync(snap)) { fs.rmSync(snap); console.log('已删除快照:', snap) }
else console.log('快照不存在（无需删）')

// ② 清掉分区里我们探针留下的 Cookie（保留真实微信凭据——用户重新登录会覆盖它们）
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pages = list.filter(x => x.type === 'page' && (x.url.includes('store.weixin.qq.com') || x.url.includes('8895')))
let cleaned = 0
for (const pg of pages) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  await send('Network.enable')
  const all = ((await send('Network.getAllCookies')).cookies || [])
  for (const c of all) {
    if (!/shopilot|probe|sp_inrun/.test(c.name)) continue
    await send('Network.deleteCookies', { name: c.name, domain: c.domain }).catch(() => {})
    cleaned++
  }
  ws.close()
}
console.log('清理探针 Cookie:', cleaned, '条')
await sleep(500)

// ③ 检查是否有同名重复（域 Cookie + host-only 各一份）
const pg = pages.find(x => x.url.includes('store.weixin.qq.com'))
if (pg) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  await send('Network.enable')
  const all = ((await send('Network.getAllCookies')).cookies || [])
  const names = all.filter(c => /weixin/.test(c.domain)).map(c => `${c.name}@${c.domain}`)
  console.log('\n当前微信相关 Cookie:', JSON.stringify(names))
  const dupNames = Object.entries(names.reduce((a, n) => (a[n.split('@')[0]] = (a[n.split('@')[0]] || 0) + 1, a), {})).filter(([, n]) => n > 1)
  console.log('同名重复:', JSON.stringify(dupNames))
  ws.close()
}
setTimeout(() => process.exit(0), 300)
