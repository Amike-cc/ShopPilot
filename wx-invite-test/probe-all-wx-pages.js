/** 逐个标签页打印 URL + 正文特征，判断 followTab/useTab 是否切错页 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))
console.log('微信相关页面数:', pages.length)
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl)
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
    const has = (t) => all.some(el => own(el) === t)
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    return JSON.stringify({
      url: location.href.replace(/^(https:\\/\\/[^/]+)/, '').slice(0, 75),
      微应用已渲染: has('详情') || has('邀请带货') || has('发送邀约') || has('合作说明'),
      有详情链接: has('详情'), 有邀请带货: has('邀请带货'), 有发送邀约: has('发送邀约'),
      正文长度: txt.length
    })
  })()`))
  ws.close()
}
setTimeout(() => process.exit(0), 300)
