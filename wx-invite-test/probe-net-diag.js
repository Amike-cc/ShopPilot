/** 诊断：Network 事件是否采集到（打印方法计数 + 全部非静态请求） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter(t => t.type === 'page' && t.url.includes('daren-square'))
  let c = null
  for (const t of list) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let seq = 0
    const pend = new Map()
    const events = []
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
      if (m.method) events.push(m)
    }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++seq
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) { c = { send, events, close: () => ws.close() }; break }
    ws.close()
  }
  if (!c) throw new Error('no live square page')
  await c.send('Network.enable', {})
  await c.send('Page.enable', {})
  c.events.length = 0
  // 触发一次点击并等待
  await c.send('Runtime.evaluate', {
    expression: `(() => { const t = el => String(el.innerText||'').replace(/\\s+/g,'').trim(); const b=[...document.querySelectorAll('button,span,a')].find(e=>t(e)==='\u641c\u7d22'); if(b){b.click();return b.tagName} return 'none' })()`,
    returnByValue: true, userGesture: true
  })
  await new Promise(r => setTimeout(r, 7000))
  const byMethod = {}
  for (const e of c.events) byMethod[e.method] = (byMethod[e.method] || 0) + 1
  console.log('event methods:', JSON.stringify(byMethod))
  const reqs = c.events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request)
  console.log('requests total:', reqs.length)
  for (const r of reqs.filter(r => !/\.(js|css|png|jpe?g|svg|woff2?|ico|gif|webp)(\?|$)/.test(r.url)).slice(0, 25)) {
    console.log(r.method, r.url.slice(0, 120), r.postData ? '\n   POST ' + r.postData.slice(0, 300) : '')
  }
  c.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
