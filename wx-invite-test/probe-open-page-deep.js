/**
 * 深入定位「打开达人广场」无反应：
 *  - document 捕获阶段记录点击目标
 *  - 同时给 navigate / prepareInviteSquare 装探针（看走了哪个分支）
 *  - 监听控制台异常（CDP Runtime.exceptionThrown / Log）
 *  - 用 CDP Input 发**受信任**点击
 * 结果写 wx-invite-test/open-page-deep.txt
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const out = []
const log = (x) => { out.push(String(x)); console.log(String(x)) }

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
const events = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') events.push({ kind: 'exception', text: JSON.stringify(m.params.exceptionDetails).slice(0, 400) })
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) events.push({ kind: m.params.type, text: (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300) })
  if (m.method === 'Log.entryAdded') events.push({ kind: 'log:' + m.params.entry.level, text: String(m.params.entry.text).slice(0, 300) })
}
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Runtime.enable'); await send('Log.enable')

// 进入面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)

log('探针安装: ' + await ev(`(() => {
  window.__deep = { clicks: [], calls: [] }
  document.addEventListener('click', e => {
    const t = e.target
    window.__deep.clicks.push({
      target: t ? (t.tagName + '[data-test=' + (t.getAttribute && t.getAttribute('data-test')) + ']') : 'null',
      text: t ? String(t.innerText || '').trim().slice(0, 20) : '',
      trusted: e.isTrusted
    })
  }, true)
  const np = window.shopilot.browser.navigate
  window.shopilot.browser.navigate = function (...a) { window.__deep.calls.push({ fn: 'navigate', a: a.map(String) }); return np.apply(this, a) }
  const pp = window.shopilot.browser.prepareInviteSquare
  window.__deep.calls.push({ fn: 'typeof prepareInviteSquare', t: typeof pp })
  if (typeof pp === 'function') {
    window.shopilot.browser.prepareInviteSquare = function (...a) {
      window.__deep.calls.push({ fn: 'prepareInviteSquare', a: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)) })
      return pp.apply(this, a).then(r => { window.__deep.calls[window.__deep.calls.length - 1].res = JSON.stringify(r).slice(0, 200); return r })
        .catch(e => { window.__deep.calls[window.__deep.calls.length - 1].err = String(e); throw e })
    }
  }
  return JSON.stringify({ navigate: typeof np, prepareInviteSquare: typeof pp })
})()`))

log('匹配到的按钮数: ' + await ev(`JSON.stringify([...document.querySelectorAll('[data-test=invite-open-page]')].map(e => {
  const r = e.getBoundingClientRect()
  return { tag: e.tagName, visible: r.width > 0 && r.height > 0, display: getComputedStyle(e).display, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], text: String(e.innerText||'').trim() }
}))`))

// 用受信任鼠标点击按钮中心
const pt = JSON.parse(await ev(`(() => {
  const e = document.querySelector('[data-test=invite-open-page]')
  if (!e) return 'null'
  const r = e.getBoundingClientRect()
  return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)])
})()`))
log('按钮坐标: ' + JSON.stringify(pt))
if (pt && Array.isArray(pt)) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(80)
  }
}
await sleep(9000)
log('捕获的点击: ' + await ev(`JSON.stringify(window.__deep.clicks)`))
log('发起的调用: ' + await ev(`JSON.stringify(window.__deep.calls)`))
log('控制台事件: ' + JSON.stringify(events.slice(-12), null, 1))
log('toast: ' + await ev(`JSON.stringify([...document.querySelectorAll('[class*=toast],[class*=notice],[role=alert]')].map(e=>String(e.innerText||'').trim()).filter(Boolean))`))
log('标签页: ' + await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'').slice(0,60)))})()`))

fs.writeFileSync('wx-invite-test/open-page-deep.txt', out.join('\n'))
setTimeout(() => process.exit(0), 300)
