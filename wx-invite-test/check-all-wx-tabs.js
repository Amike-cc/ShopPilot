/** 逐个店铺标签页看正文头部 + 是否"登录超时"（判断登录态真相） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
for (const t of list.filter(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))) {
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
  const r = await send('Runtime.evaluate', {
    expression: `(function(){var t=String(document.body?document.body.innerText:'').replace(/\\s+/g,' ');return JSON.stringify({w:innerWidth,len:t.length,expired:/登录超时/.test(t),head:t.slice(0,90)})})()`,
    returnByValue: true
  })
  console.log(String(t.url).slice(0, 90))
  console.log('   ', r.result?.value)
  ws.close()
}
process.exit(0)
