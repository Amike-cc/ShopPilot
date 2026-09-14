/** 查面板按钮的事件监听（CDP DOMDebugger）+ Vue 痕迹；结果写文件，避免 stdout 被截断 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const out = []
const log = (x) => { out.push(x); console.log(x) }

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
await send('Runtime.enable'); await send('DOM.enable')

log('面板是否在 DOM: ' + await ev(`JSON.stringify({
  open: !!document.querySelector('[data-test=invite-open-page]'),
  start: !!document.querySelector('[data-test=invite-start]'),
  stop: !!document.querySelector('[data-test=invite-stop]'),
  panel: !!document.querySelector('[data-test=invite-panel]'),
  panelVisible: (() => { const p = document.querySelector('[data-test=invite-panel]'); return p ? p.getBoundingClientRect().width > 0 : false })()
})`))

for (const sel of ['[data-test=invite-open-page]', '[data-test=invite-start]']) {
  const r = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})`, returnByValue: false })
  const objId = r.result && r.result.objectId
  if (!objId) { log(sel + ' → 不在 DOM'); continue }
  try {
    const l = await send('DOMDebugger.getEventListeners', { objectId: objId, depth: 2, pierce: true })
    log(sel + ' → ' + JSON.stringify((l.listeners || []).map(x => x.type)))
  } catch (e) { log(sel + ' → getEventListeners 失败: ' + String(e.message).slice(0, 100)) }
  try {
    const desc = await send('Runtime.getProperties', { objectId: objId, ownProperties: true })
    const keys = (desc.result || []).map(p => p.name).filter(n => /vue|vnode|_v/i.test(n))
    log('   Vue 相关自有属性: ' + JSON.stringify(keys))
  } catch (e) { log('   getProperties 失败: ' + String(e.message).slice(0, 80)) }
}
fs.writeFileSync('wx-invite-test/btn-listeners-out.txt', out.join('\n'))
ws.close()
setTimeout(() => process.exit(0), 300)
