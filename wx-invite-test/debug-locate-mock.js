/** 在 8898 仿真页上直接跑与 handler 相同的定位脚本，看能否找到元素与坐标 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const LOCATE = (needle, exact) => `(() => {
  const out = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = []
  for (const el of out) {
    const t = own(el)
    if (${exact} ? t !== ${JSON.stringify(needle)} : !t.includes(${JSON.stringify(needle)})) continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    hits.push({ tag: el.tagName, t: t.slice(0, 20), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vis: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' })
  }
  return JSON.stringify({ total: out.length, hits: hits.slice(0, 5) })
})()`

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const pages = list.filter(x => x.type === 'page' && x.url.includes('8898'))
  console.log('pages on 8898:', pages.length)
  for (const t of pages) {
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
    const r0 = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (!(r0.result?.value > 0)) { ws.close(); continue }
    const r1 = await send('Runtime.evaluate', { expression: LOCATE('直播带货者', true), returnByValue: true })
    console.log('locate 直播带货者:', r1.result?.value || JSON.stringify(r1.exceptionDetails).slice(0, 200))
    const r2 = await send('Runtime.evaluate', { expression: LOCATE('母婴', true), returnByValue: true })
    console.log('locate 母婴:', r2.result?.value || JSON.stringify(r2.exceptionDetails).slice(0, 200))
    ws.close()
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
