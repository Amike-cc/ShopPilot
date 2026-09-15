/** 找打开「任务面板」的入口控件（左栏/工具栏里的按钮），并 dump 所有 data-test。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
console.log('=== 全部 data-test（前 60）===')
console.log(await ev(`[...document.querySelectorAll('[data-test]')].map(e => e.getAttribute('data-test')).slice(0, 60).join('\\n')`))
console.log('\n=== 左栏全部按钮文案（含图标）===')
console.log(await ev(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const t = String(b.innerText || '').replace(/\\s+/g,' ').trim()
    const r = b.getBoundingClientRect()
    if (!(r.width > 0)) continue
    out.push((t.slice(0,18) || '(无文字)') + '  test=' + (b.getAttribute('data-test')||'') + ' cls=' + String(b.className||'').slice(0,30) + ' x=' + Math.round(r.left) + ' y=' + Math.round(r.top))
  }
  return out.slice(0, 45).join('\\n')
})()`))
console.log('\n=== 中栏/右栏容器 class ===')
console.log(await ev(`(() => {
  const out = []
  for (const el of document.querySelectorAll('div,aside,section')) {
    const r = el.getBoundingClientRect()
    if (r.width < 200 || r.height < 300) continue
    const cls = String(el.className||'')
    if (!cls) continue
    out.push(cls.split(' ').slice(0,2).join('.') + '  ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' x=' + Math.round(r.left))
  }
  return [...new Set(out)].slice(0, 20).join('\\n')
})()`))
ws.close()
setTimeout(() => process.exit(0), 200)
