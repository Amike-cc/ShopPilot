/** 查 chip 与级联弹层的关联属性（aria-controls / aria-owns / id / data-*） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  let c = null
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('daren-square'))) {
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
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) { c = { send }; break }
    ws.close()
  }
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  const out = JSON.parse(await ev(`(() => {
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const row = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
    const item = row && row.closest('.auxo-form-item-row')
    const a = [...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')][2]  // 个护家清
    const attrs = el => { const o = {}; for (const at of el.attributes) o[at.name] = String(at.value).slice(0, 60); return o }
    const chip = { tag: a.tagName, attrs: attrs(a), parentAttrs: attrs(a.parentElement) }
    const chipChain = []
    let p = a.parentElement
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) chipChain.push({ tag: p.tagName, id: p.id || null, cls: String(p.className).slice(0, 40), attrs: Object.keys(attrs(p)) })
    const pop = document.querySelectorAll('.quick-filter-cascader-popover')[2]
    const popInfo = { attrs: attrs(pop), parentAttrs: pop.parentElement ? attrs(pop.parentElement) : null }
    return JSON.stringify({ chip, chipChain, popInfo }, null, 1)
  })()`))
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
