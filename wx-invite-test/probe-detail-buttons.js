/** 看当前停留的达人详情页：有没有「邀请带货」？还是有「已邀约」等状态？ */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const det = list.find(x => x.type === 'page' && x.url.includes('finder-detail'))
if (!det) { console.log('没有详情页'); process.exit(0) }
const ws = new WebSocket(det.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('URL:', String(det.url).slice(0, 110))
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  // 找按钮类元素（含"邀请/邀约/联系"字样）
  const btns = all.filter(el => /^(BUTTON|A)$/.test(el.tagName) && el.getBoundingClientRect().width > 0)
    .map(el => ({ tag: el.tagName, text: String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20), cls: String(el.className || '').slice(0, 55), disabled: /disabled/i.test(String(el.className || '')) }))
    .filter(b => b.text && (/邀请|邀约|联系|合作/.test(b.text)))
  return JSON.stringify({
    expired: /登录超时/.test(txt),
    has邀请带货: all.some(el => own(el) === '邀请带货'),
    相关按钮: btns,
    关键词命中: ['邀请带货', '已邀约', '邀请中', '暂不可邀', '无法邀约', '已发送'].filter(k => txt.includes(k)),
    正文片段: txt.slice(0, 220)
  }, null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
