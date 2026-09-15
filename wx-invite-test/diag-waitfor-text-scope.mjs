/**
 * 验证：waitForText 的 within={text:'已选', climb:1} 能不能定位到范围容器？
 * 实测「已选1个」是一个元素（.pro-tagForm-result__label）的**完整文本**，
 * 但它的上级行容器文本是「已选1个 个护家清: 清空」——上溯后是否仍包含「个护家清」。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('没有达人广场页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
console.log('页面:', pg.url.slice(0, 80))

console.log('\n=== 「已选」标记的元素与上溯链（复刻 __scopeRoots 的 text 分支）===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // __scopeRoots 的 text 分支：own === text 或 (own.includes(text) && own.length <= text.length + 12)
  const cands = []
  for (const el of all) {
    const o = own(el)
    if (o === '已选' || (o.includes('已选') && o.length <= '已选'.length + 12)) cands.push({ el, len: o.length, o })
  }
  const out = cands.map(c => 'own="' + c.o.slice(0,24) + '" <' + c.el.tagName + '.' + String(c.el.className||'').slice(0,44) + '>')
  return out.length ? out.slice(0,8).join('\\n') : '(没有元素的自有文本满足条件)'
})()`))

console.log('\n=== 若取到候选，climb=1 后容器文本是否含「个护家清」===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => { const o = own(el); return o === '已选' || (o.includes('已选') && o.length <= 14) })
  if (!cands.length) return '(无候选 → within 范围解析失败 → waitForText 直接返回 false，必然超时)'
  cands.sort((a,b) => own(a).length - own(b).length)
  let root = cands[0]
  root = root.parentElement  // climb=1
  if (!root) return '(上溯失败)'
  return JSON.stringify({ 容器: root.tagName + '.' + String(root.className||'').slice(0,44), 容器文本: String(root.innerText||'').replace(/\\s+/g,' ').slice(0,80), 含个护家清: String(root.innerText||'').includes('个护家清') }, null, 1)
})()`))

console.log('\n=== 直接看「已选」相关元素的层级（找出正确的锚点）===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!/个护家清/.test(t) || t.length > 60) continue
    const cls = String(el.className||'')
    out.push('<' + el.tagName + '.' + cls.slice(0,46) + '> text="' + t.slice(0,44) + '" result=' + /result/.test(cls))
  }
  return [...new Set(out)].slice(0, 12).join('\\n')
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
