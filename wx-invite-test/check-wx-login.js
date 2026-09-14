/** 重载微信广场页，确认登录态是否真的过期（还是仅页面需要刷新） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('findersquare/find'))
  if (!t) { console.log('no find page'); process.exit(0) }
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.evaluate', { expression: 'location.reload();1', returnByValue: true })
  await new Promise(r => setTimeout(r, 6000))
  const r = await send('Runtime.evaluate', {
    expression: '(function(){return JSON.stringify({url:location.href.slice(0,70),body:String(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,120),hasQR:!!document.querySelector("img[src*=qrcode],canvas,.login-qrcode")})})()',
    returnByValue: true, awaitPromise: true
  })
  console.log(r.result?.value)
  // 顺便看 cookie 是否还在（长度）
  const c = await send('Runtime.evaluate', { expression: 'String(document.cookie).length', returnByValue: true })
  console.log('document.cookie length:', c.result?.value)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
