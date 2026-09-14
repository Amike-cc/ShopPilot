/** 给 prepareInviteSquare 装调用探针，再点面板按钮：看处理函数有没有发起调用、参数是什么、是否有异常 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

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
  if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 400)
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('① 装探针:', await ev(`(() => {
  window.__calls = []
  window.__errs = []
  const orig = window.shopilot.browser.prepareInviteSquare
  window.shopilot.browser.prepareInviteSquare = function (...a) {
    window.__calls.push({ args: a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))) })
    return orig.apply(this, a).then(r => { window.__calls[window.__calls.length-1].res = JSON.stringify(r).slice(0,200); return r })
      .catch(e => { window.__calls[window.__calls.length-1].err = String(e); throw e })
  }
  window.addEventListener('error', e => window.__errs.push(String(e.message)))
  window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String(e.reason && e.reason.message || e.reason)))
  return 'ok'
})()`))

console.log('② 面板状态:', await ev(`(() => {
  const b = document.querySelector('[data-test=invite-open-page]')
  const panel = document.querySelector('[data-test=invite-panel]')
  return JSON.stringify({
    btnExists: !!b, btnVisible: b ? b.getBoundingClientRect().width > 0 : false,
    panelVisible: panel ? panel.getBoundingClientRect().width > 0 : false,
    type: (document.querySelector('[data-test=invite-finder-type]')||{}).value
  })
})()`))

console.log('③ 点击:', await ev(`(() => { const b = document.querySelector('[data-test=invite-open-page]'); b.click(); return 'clicked' })()`))
await sleep(9000)
console.log('④ 调用记录:', await ev(`JSON.stringify(window.__calls || [])`))
console.log('⑤ 捕获到的异常:', await ev(`JSON.stringify(window.__errs || [])`))
console.log('⑥ 标签页:', await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,tabs:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'').slice(0,60)}))})})()`))
ws.close()
process.exit(0)
