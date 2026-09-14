/** 详查广场页「带货类目/母婴」筛选控件的真实选中态，以及所有筛选摘要文本 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const sqT = targets.find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (!sqT) { console.log('没有广场页'); process.exit(0) }
const ws = new WebSocket(sqT.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // 所有含「母婴」的元素
  const hits = []
  for (const el of all) {
    const t = own(el)
    if (!t.includes('母婴')) continue
    const r = el.getBoundingClientRect()
    hits.push({
      tag: el.tagName, cls: String(el.className || '').slice(0, 50), text: t.slice(0, 30),
      visible: r.width > 0 && r.height > 0,
      parentCls: String((el.parentElement && el.parentElement.className) || '').slice(0, 50),
      grandCls: String((el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className) || '').slice(0, 50),
      // 自身或祖先里的 checkbox 状态
      cb: (() => {
        let n = el
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const c = n.querySelector && n.querySelector('input[type=checkbox]')
          if (c) return { checked: c.checked, tag: n.tagName, cls: String(n.className || '').slice(0, 40) }
        }
        return null
      })()
    })
  }
  // 筛选摘要：找包含「：」的短标签
  const summary = [...new Set(all.map(el => own(el)).filter(t => t && t.length < 60 && /^(带货类目|其他筛选|类型|带货者类型)[：:]/.test(t)))]
  return JSON.stringify({ 母婴元素: hits.slice(0, 6), 筛选摘要: summary }, null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
