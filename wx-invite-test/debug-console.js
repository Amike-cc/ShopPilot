/** 抓渲染层 console：点击等级 chip 后收集 3 秒内的日志与异常 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  const logs = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: m.params.type, text: m.params.args.map(a => a.value != null ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 220) })
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push({ type: 'EXCEPTION', text: JSON.stringify(m.params.exceptionDetails).slice(0, 300) })
    }
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m2 => m2.error ? err(new Error(JSON.stringify(m2.error))) : ok(m2.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  // 真实点击 LV5（未勾选）
  await send('Runtime.evaluate', {
    expression: `(()=>{const c=document.querySelector('[data-test=invite-level-LV5]');if(!c)return 'no-chip';c.click();return 'clicked'})()`,
    returnByValue: true, userGesture: true
  })
  await new Promise(r => setTimeout(r, 3000))
  console.log('console entries:', JSON.stringify(logs, null, 1))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
