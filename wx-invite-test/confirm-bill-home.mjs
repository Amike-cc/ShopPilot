/** 确认 /shop/bill/home 真的是发票中心（等微应用渲染完，读 ShadowRoot 内的文本） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.find(x => x.type === 'page' && x.url.includes('/shop/bill/home'))
if (!pg) { console.log('没有 /shop/bill/home 页面'); process.exit(0) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

for (let i = 0; i < 8; i++) {
  console.log(`+${i * 3}s`, await ev(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const deepText = all.map(own).filter(Boolean).join(' ').replace(/\\s+/g, ' ')
    return JSON.stringify({
      微应用节点: document.querySelectorAll('micro-app').length,
      深层文本长度: deepText.length,
      含发票: /发票/.test(deepText),
      片段: deepText.slice(0, 130)
    })
  })()`))
  await sleep(3000)
}
ws.close()
setTimeout(() => process.exit(0), 300)
