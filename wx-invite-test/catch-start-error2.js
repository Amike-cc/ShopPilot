/** 装 unhandledrejection/onerror 钩子后再点开始邀约，读出真实报错 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = async (expr) => (await new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  }))
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  console.log('装钩子:', await ev(`(() => {
    window.__err = []
    window.addEventListener('unhandledrejection', e => { window.__err.push('REJECT: ' + String(e.reason && (e.reason.stack || e.reason.message || e.reason))) })
    window.addEventListener('error', e => { window.__err.push('ERROR: ' + String(e.message) + ' @' + e.lineno) })
    const orig = console.error
    console.error = function (...a) { window.__err.push('CONSOLE.ERROR: ' + a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ').slice(0, 400)); orig.apply(console, a) }
    return 'hooked'
  })()`))
  console.log('click:', await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'no-btn';b.click();return 'clicked'})()`))
  await sleep(4000)
  console.log('捕获:', await ev(`JSON.stringify(window.__err || [])`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
