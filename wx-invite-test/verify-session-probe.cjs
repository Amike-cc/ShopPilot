/**
 * 会话级 Cookie 持久化 —— 干净验证（避免站点干扰）
 *   ① 往分区写一条**会话级** Cookie（中性域名 .shopilot-probe.test，不会被站点清理）
 *   ② 触发快照 → 强杀应用（最恶劣情况，不走退出钩子）
 *   ③ 重启后**不访问该域名**，直接读分区 Cookie 看是否幸存
 * 用法：node verify-session-probe.cjs set|check
 */
const fs = require('fs')
const path = require('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const STAMP_FILE = path.join(__dirname, 'session-probe-stamp.txt')
const mode = process.argv[2] || 'set'

async function connectApp() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  if (!app) throw new Error('应用未运行')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
  }
  return { ev, close: () => ws.close() }
}
/** 找一个属于该店铺分区的页面来写 Cookie（用同一 partition 的任意页面） */
async function partitionPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const p = list.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com')) || list.find(x => x.type === 'page' && x.url.includes('buyin.jinritemai'))
  return p || null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await connectApp()
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(3500)

  if (mode === 'set') {
    const pg = await partitionPage()
    if (!pg) { console.log('没有可用于写 Cookie 的店铺页面'); process.exit(1) }
    const ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0; const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
    await send('Network.enable')
    const stamp = String(Date.now())
    const r = await send('Network.setCookie', { name: 'shopilot_sess_probe', value: stamp, domain: 'shopilot-probe.test', path: '/', secure: true })
    console.log('写入会话级 Cookie:', JSON.stringify(r), '(值=' + stamp + ')')
    fs.writeFileSync(STAMP_FILE, stamp)
    ws.close()
    console.log('等防抖快照（3s）+ 余量…')
    await sleep(9000)
    const snap = path.join(process.env.APPDATA, 'shopilot', 'stores', STORE, 'session-cookies.enc')
    console.log('快照文件:', fs.existsSync(snap) ? fs.statSync(snap).size + 'B' : '(不存在)')
    console.log('下一步：强杀并重启应用，然后跑 check')
  } else {
    const stamp = fs.existsSync(STAMP_FILE) ? fs.readFileSync(STAMP_FILE, 'utf8').trim() : ''
    console.log('期望值:', stamp || '(未知)')
    const res = await app.ev(`(async () => {
      const r = await window.shopilot.session.cookies('${STORE}')
      const all = (r.data && r.data.cookies) || []
      const p = all.filter(c => c.name === 'shopilot_sess_probe')
      return JSON.stringify({ total: all.length, probe: p.map(c => ({ value: c.value, session: !c.expirationDate })) })
    })()`)
    console.log('分区 Cookie:', res)
    const parsed = (() => { try { return JSON.parse(res) } catch { return {} } })()
    const p = (parsed.probe || [])[0]
    if (p && p.value === stamp) console.log(`\n✓ 会话级 Cookie 跨重启幸存，值一致（session=${p.session}）`)
    else if (p) console.log(`\n△ 存在但值不同: 现=${p.value} 期望=${stamp}`)
    else console.log('\n✗ 会话级 Cookie 没幸存')
  }
  app.close()
}
main().then(() => setTimeout(() => process.exit(0), 300)).catch(e => { console.error('ERR', e.message); process.exit(1) })
