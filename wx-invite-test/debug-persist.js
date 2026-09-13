/** 诊断持久化链路：settings 回环 / 存档键列表 / 面板模型当前值 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  console.log('roundtrip:', await ev(`(async () => {
    const w = window.shopilot
    const probeKey = 'invite.config.__probe__'
    const s1 = await w.settings.set(probeKey, { hello: 'world', n: 42 })
    const g1 = await w.settings.get(probeKey)
    return JSON.stringify({ setOk: s1.ok, getOk: g1.ok, value: g1.data && g1.data.value })
  })()`))
  console.log('invite cfg key:', await ev(`(async () => {
    const r = await window.shopilot.settings.get('invite.config.抖店')
    return JSON.stringify(r)
  })()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
