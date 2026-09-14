/** 详情页微应用为何不挂载：看 iframe 是什么、页面里有哪些容器、是否有 micro-app 脚本 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const det = list.filter(x => x.type === 'page' && x.url.includes('finder-detail')).pop()
if (!det) { console.log('没有详情页'); process.exit(0) }
const ws = new WebSocket(det.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('URL:', String(det.url).slice(0, 120))
console.log(await ev(`(() => {
  const ifr = document.querySelector('iframe')
  return JSON.stringify({
    iframe: ifr ? { src: String(ifr.getAttribute('src') || '').slice(0, 120), id: ifr.id, cls: String(ifr.className || '').slice(0, 40) } : null,
    bodyChildren: [...document.body.children].map(e => e.tagName + (e.id ? '#' + e.id : '') + (e.className ? '.' + String(e.className).slice(0, 30) : '')).slice(0, 14),
    hasMicroAppScript: [...document.querySelectorAll('script')].map(s => String(s.src || '').slice(0, 70)).filter(Boolean).slice(0, 8),
    innerHTMLHead: document.body ? document.body.innerHTML.replace(/\\s+/g, ' ').slice(0, 400) : ''
  }, null, 1)
})()`))
// 看 console 有没有报错（重新加载触发一次）
console.log('\n重新加载页面并抓 console/网络失败…')
const fails = []
const onMsg = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.loadingFailed') fails.push({ kind: 'net', url: m.params.documentURL || '', err: m.params.errorText })
  if (m.method === 'Runtime.exceptionThrown') fails.push({ kind: 'exc', text: JSON.stringify(m.params.exceptionDetails).slice(0, 200) })
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') fails.push({ kind: 'console', text: (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200) })
}
ws.removeAllListeners && ws.removeAllListeners('message')
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return } onMsg(e) }
await send('Network.enable'); await send('Runtime.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise(r => setTimeout(r, 15000))
console.log('微应用挂载情况:', await ev(`JSON.stringify({ microApp: document.querySelectorAll('micro-app').length, 邀请带货: [...document.querySelectorAll('*')].some(el => [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim() === '邀请带货') })`))
console.log('失败/异常（前 12 条）:', JSON.stringify(fails.slice(0, 12), null, 1))
ws.close()
setTimeout(() => process.exit(0), 300)
