/** 查面板的滚动容器与结构（判断 sticky 吸底是否可行） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log(await ev(`(() => {
  const p = document.querySelector('[data-test=invite-panel]')
  const out = []
  let n = p
  for (let i = 0; i < 7 && n; i++, n = n.parentElement) {
    if (!n) break
    const cs = getComputedStyle(n)
    const r = n.getBoundingClientRect()
    out.push({
      i, tag: n.tagName,
      cls: String(n.className || '').slice(0, 45),
      overflowY: cs.overflowY,
      scrollable: n.scrollHeight > n.clientHeight + 4,
      h: Math.round(r.height),
      clientH: n.clientHeight, scrollH: n.scrollHeight
    })
  }
  return JSON.stringify(out, null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
