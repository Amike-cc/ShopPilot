/** 打印邀约表单页全文 + 所有含"剩余/额度/次数/邀请"的文本片段（找真实额度文案） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const form = list.find(x => x.type === 'page' && x.url.includes('initiate-invite'))
if (!form) { console.log('没有表单页'); process.exit(0) }
const ws = new WebSocket(form.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('URL:', form.url.slice(0, 110))
console.log('--- 全文 ---')
console.log(await ev(`String(document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n')`))
console.log('--- 含关键词的片段 ---')
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = []
  for (const el of all) {
    const t = own(el)
    if (!t) continue
    if (/剩余|额度|次数|机会|上限|今日|每天|每日/.test(t) && t.length < 90) hits.push(t)
  }
  return JSON.stringify([...new Set(hits)], null, 1)
})()`))
ws.close()
process.exit(0)
