/**
 * 在 initiate-invite 目标页按页面坐标点一下（CDP Input 域，受信任事件）。
 * 用法：node click.js <x> <y>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const x = Number(process.argv[2]); const y = Number(process.argv[3])

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find(x => x.url.includes('initiate-invite'))
  if (!t) throw new Error('initiate-invite 页不在打开的目标里')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(method + ' ' + JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  const r = await send('Runtime.evaluate', { expression: 'location.href.slice(0,120)', returnByValue: true })
  console.log('clicked', x, y, '->', r.result.value)
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
