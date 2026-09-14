/** 监听渲染层异常：点开始邀约，捕获抛错的堆栈 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  const events = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      events.push({ kind: 'EXCEPTION', text: (d.exception && (d.exception.description || d.exception.value)) || d.text, url: String(d.url || '').slice(-40), line: d.lineNumber })
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push({ kind: m.params.type, text: m.params.args.map(a => a.value != null ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 400) })
    }
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'no-btn';b.click();return 'clicked'})()`, returnByValue: true, userGesture: true })
  await new Promise(r => setTimeout(r, 4000))
  console.log('事件：')
  for (const e of events) console.log(' -', e.kind, '|', String(e.text).slice(0, 500), e.line != null ? `(line ${e.line})` : '')
  if (!events.length) console.log(' （无异常/错误日志）')
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
