/** 用 CDP DOMDebugger 查「打开达人广场」「开始邀约」按钮上有没有事件监听，并看 Vue 是否接管 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })

await send('Runtime.enable')
await send('DOM.enable')

async function listenersOf(selector) {
  const r = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false })
  const objId = r.result && r.result.objectId
  if (!objId) return { selector, found: false }
  try {
    const l = await send('DOMDebugger.getEventListeners', { objectId: objId, depth: 2, pierce: true })
    return { selector, found: true, listeners: (l.listeners || []).map(x => ({ type: x.type, useCapture: x.useCapture, passive: x.passive })) }
  } catch (e) {
    return { selector, found: true, error: String(e.message).slice(0, 120) }
  }
}
for (const sel of ['[data-test=invite-open-page]', '[data-test=invite-start]', '[data-test=invite-stop]']) {
  console.log(JSON.stringify(await listenersOf(sel)))
}

// Vue 是否接管的痕迹
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('\nVue 痕迹:', await ev(`(() => {
  const b = document.querySelector('[data-test=invite-open-page]')
  if (!b) return 'no-btn'
  const keys = Object.keys(b).filter(k => /^__vue|^_v|vue/i.test(k))
  const parentKeys = b.parentElement ? Object.keys(b.parentElement).filter(k => /^__vue|^_v/i.test(k)) : []
  return JSON.stringify({ tag: b.tagName, text: String(b.innerText||'').trim(), ownKeys: keys, parentKeys, hasVnode: !!b.__vnode, onclickAttr: b.getAttribute('onclick') })
})()`))
ws.close()
process.exit(0)
