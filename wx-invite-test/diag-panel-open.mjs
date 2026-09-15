/** 诊断：任务面板/邀约页签为什么没打开（找正确的开关 selector）。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
console.log('当前视口:', await ev(`innerWidth + 'x' + innerHeight`))
console.log('\n=== 页面上所有 data-test 里含 task/invite 的元素 ===')
console.log(await ev(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[data-test]')) {
    const t = el.getAttribute('data-test')
    if (!/task|invite/i.test(t)) continue
    const r = el.getBoundingClientRect()
    out.push(t + '  <' + el.tagName + '> ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' vis=' + (r.width > 0))
  }
  return out.slice(0, 40).join('\\n')
})()`))
console.log('\n=== 任务面板容器是否在 DOM ===')
console.log(await ev(`JSON.stringify({
  invitePanel: !!document.querySelector('[data-test=invite-panel]'),
  taskSubtabs: !!document.querySelector('[data-test=task-subtabs]'),
  taskPanel: !!document.querySelector('[data-test=task-panel]'),
  所有含invite的data-test: [...document.querySelectorAll('[data-test*=invite]')].map(e=>e.getAttribute('data-test')).slice(0,20)
}, null, 1)`))
console.log('\n=== 左栏/工具栏按钮（找打开任务面板的入口）===')
console.log(await ev(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button, [role=button], a')) {
    const t = String(b.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 14) continue
    if (!/任务|邀约|面板|工具/.test(t)) continue
    const r = b.getBoundingClientRect()
    if (!(r.width > 0)) continue
    out.push(t + '  <' + b.tagName + '> test=' + (b.getAttribute('data-test')||'') + ' y=' + Math.round(r.top))
  }
  return [...new Set(out)].slice(0, 25).join('\\n')
})()`))
console.log('\n=== 正文片段（看当前停在哪）===')
console.log(String(await ev(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 400)`)))
ws.close()
setTimeout(() => process.exit(0), 200)
