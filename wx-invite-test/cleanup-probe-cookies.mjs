/** 清理验证用的探针 Cookie（.weixin.qq.com 与中性域各一），只删我们加的两条 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pages = list.filter(x => x.type === 'page' && (x.url.includes('store.weixin.qq.com') || x.url.includes('127.0.0.1:8895')))
let removed = 0
for (const pg of pages) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0; const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  await send('Network.enable')
  for (const c of [['shopilot_sess_probe', '.shopilot-probe.test'], ['shopilot_probe_session', '.weixin.qq.com'], ['shopilot_probe_persist', '.weixin.qq.com'], ['sp_inrun', 'shopilot-probe.test']]) {
    const r = await send('Network.deleteCookies', { name: c[0], domain: c[1] }).catch(() => null)
    if (r !== null) removed++
  }
  const left = ((await send('Network.getAllCookies')).cookies || []).filter(c => /shopilot|sp_inrun/.test(c.name))
  console.log('页面:', String(pg.url).slice(0, 45), '剩余探针:', left.length)
  ws.close()
}
console.log('已发送删除请求:', removed)
setTimeout(() => process.exit(0), 300)
