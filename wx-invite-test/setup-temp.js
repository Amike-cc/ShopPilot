/** 在临时验证实例（9251）里建仿真店 + 打开仿真邀约页 */
const PORT = '9251'
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
async function main() {
  for (let i = 0; i < 30; i++) { try { await j('/json/version'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const list = await targets()
  const t = list.find(x => x.title === 'ShopPilot')
  if (!t) throw new Error('no ShopPilot target')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const res = await ev(`(async () => {
    const stores = await window.shopilot.store.list()
    const list = stores.data.stores || stores.data
    let sid = (list.find(s => s.name === '微信仿真店') || {}).id
    if (!sid) {
      const c = await window.shopilot.store.create({ name: '微信仿真店', platform: '微信小店', adminUrl: 'http://127.0.0.1:8765' })
      if (!c.ok) return JSON.stringify(c)
      sid = c.data.id
    }
    await window.shopilot.browser.open(sid)
    await window.shopilot.browser.display(sid)
    const tl = await window.shopilot.browser.tab.create(sid, 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=v2_mocktoken@finder')
    return JSON.stringify({ store: sid.slice(-8), tab: tl.ok })
  })()`)
  console.log(res)
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
