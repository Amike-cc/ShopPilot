/** 直接读面板 store 里的任务列表，确认「达人邀约 ·」前缀的任务是否存在（判断历史卡片为 0 是过滤问题还是未刷新） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
console.log('IPC 任务列表里符合前缀的:', await ev(`(async () => {
  const r = await window.shopilot.task.list()
  const all = Array.isArray(r.data) ? r.data : []
  const hit = all.filter(t => String(t.name).startsWith('达人邀约 ·'))
  return JSON.stringify({ 总数: all.length, 前缀命中: hit.length, 名称: hit.slice(0,3).map(t => ({ name: t.name, scope: t.storeScope, status: (t.latestRun||{}).status })) })
})()`))
console.log('面板 DOM 历史卡片:', await ev(`document.querySelectorAll('[data-test=invite-history-card]').length`))
console.log('面板当前显示的店铺:', await ev(`(() => { const c = document.querySelector('.store-card.on, .store-card.selected, .store-card.active'); return c ? String(c.innerText||'').replace(/\\s+/g,' ').slice(0,40) : '(未选中)' })()`))
console.log('当前子页签:', await ev(`(() => JSON.stringify([...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].map(e => String(e.innerText||'').trim() + (/(on|active|current)/i.test(String(e.className||'')) ? '(选中)' : '')))`))
ws.close()
setTimeout(() => process.exit(0), 300)
