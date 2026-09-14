/** 打开发票中心，检查表格行高并截图 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
await ev(`(async()=>{await window.shopilot.browser.display(null);return 1})()`)
await sleep(1200)
await ev(`document.querySelector('[data-test=invoice-center-open]').click()`)
await sleep(3500)
console.log(await ev(`(() => {
  const tables = [...document.querySelectorAll('[data-test=invoice-table]')]
  if (!tables.length) return 'no-table'
  return JSON.stringify(tables.map(t => {
    const trs = [...t.querySelectorAll('tbody tr')]
    return {
      行数: trs.length,
      各行高: trs.map(r => Math.round(r.getBoundingClientRect().height)),
      首行额外列: (t.querySelector('.inv-cell-extra') || {}).innerText || null
    }
  }), null, 1)
})()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-invoice-final.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-invoice-final.png')
ws.close()
setTimeout(() => process.exit(0), 300)
