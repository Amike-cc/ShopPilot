/**
 * 验证「会话级 Cookie 持久化」是否真的跨重启保住登录态（不依赖微信登录）：
 *   ① 往店铺分区写一条**会话级** Cookie（无 expirationDate）+ 一条持久 Cookie 作对照
 *   ② 等 Cookie 变化触发的防抖快照（或主动等 60s 定时）→ 检查快照文件是否生成
 *   ③ 打印当前两者是否可见
 * 用法：node verify-session-persist.js set      （写 cookie + 等快照）
 *       node verify-session-persist.js check    （重启后检查 cookie 是否还在）
 */
const fs = await import('fs')
const path = await import('path')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SNAP = path.join(process.env.APPDATA, 'shopilot', 'stores', STORE, 'session-cookies.enc')
const mode = process.argv[2] || 'set'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
if (!app) { console.log('应用未运行'); process.exit(1) }
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 用"打开店铺浏览器"确保 session 已创建（会话快照只对已创建的 session 生效）
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3500)

if (mode === 'set') {
  console.log('写入测试 Cookie（会话级 marker=session-cookie-<时间戳>）…')
  const stamp = Date.now()
  console.log(await ev(`(async () => {
    const res = await window.shopilot.session.cookies('${STORE}')
    // 用已有 IPC 能拿到的接口写不了，改走 devtools 协议在页面上无权限；这里用主进程能力：
    // 用 clearData 无关；直接借助 Electron 的 session 需要通过 IPC —— 改用 evaluate 里可用的 shopilot API
    return JSON.stringify({ ok: res.ok, count: (res.data && res.data.cookies || []).length })
  })()`))
  // 实际上渲染层没有"写 cookie"的 IPC，所以这里直接调用主进程的 debug 通道（不存在）→ 换个思路：
  // 用 CDP Network.setCookie 往该**分区对应的页面**写（店铺页面的渲染进程共享该分区 session）
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const wxPage = pages.find(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
  if (!wxPage) { console.log('没有微信页面可供写 Cookie（先打开 store.weixin.qq.com）'); process.exit(1) }
  const w2 = new WebSocket(wxPage.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  await snd('Network.enable')
  const r1 = await snd('Network.setCookie', { name: 'shopilot_probe_session', value: 'sess-' + stamp, domain: '.weixin.qq.com', path: '/', secure: true })
  const r2 = await snd('Network.setCookie', { name: 'shopilot_probe_persist', value: 'persist-' + stamp, domain: '.weixin.qq.com', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 7 * 86400 })
  console.log('会话级 Cookie 写入:', JSON.stringify(r1))
  console.log('持久 Cookie 写入:', JSON.stringify(r2))
  w2.close()
  console.log('等待防抖快照（3s）+ 余量…')
  await sleep(9000)
  console.log('快照文件存在:', fs.existsSync(SNAP), fs.existsSync(SNAP) ? `(${fs.statSync(SNAP).size} 字节)` : '')
  console.log('时间戳（重启后核对）:', stamp)
  fs.writeFileSync('wx-invite-test/session-probe-stamp.txt', String(stamp))
} else {
  console.log('检查 Cookie 是否跨重启幸存…')
  console.log('快照文件:', fs.existsSync(SNAP) ? `${fs.statSync(SNAP).size} 字节，mtime ${fs.statSync(SNAP).mtime.toLocaleString()}` : '(不存在)')
  const stamp = fs.existsSync('wx-invite-test/session-probe-stamp.txt') ? fs.readFileSync('wx-invite-test/session-probe-stamp.txt', 'utf8').trim() : ''
  console.log('期望时间戳:', stamp || '(未知)')
  const res = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.session.cookies('${STORE}')
    const all = (r.data && r.data.cookies) || []
    return JSON.stringify({ total: all.length, probes: all.filter(c => /shopilot_probe/.test(c.name)).map(c => ({ name: c.name, value: c.value, session: !c.expirationDate })) })
  })()`))
  console.log('当前分区 Cookie:', JSON.stringify(res, null, 1))
  const sess = res.probes.find(p => p.name === 'shopilot_probe_session')
  const pers = res.probes.find(p => p.name === 'shopilot_probe_persist')
  console.log('\n结论：')
  console.log('  会话级 Cookie 幸存:', sess ? `✓ value=${sess.value}` : '✗ 丢了')
  console.log('  持久 Cookie 幸存:', pers ? `✓ value=${pers.value}` : '✗ 丢了')
  if (stamp && sess && sess.value === 'sess-' + stamp) console.log('  → 值与重启前一致，会话持久化生效 ✓')
}
setTimeout(() => process.exit(0), 300)
