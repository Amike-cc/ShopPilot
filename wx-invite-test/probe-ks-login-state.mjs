/** 看快手登录页当前是什么状态（扫码页 / 已登录跳转中 / 报错），并截图。只读。 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pgs = list.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))
console.log('快手标签页数:', pgs.length)
for (const pg of pgs) console.log(' -', pg.url.slice(0, 110))
const pg = pgs[0]
if (!pg) process.exit(1)
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
console.log('\n视口:', await q(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
console.log('正文:', String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 600)`)))
console.log('\n关键元素:')
console.log(await q(`(() => {
  const out = []
  for (const sel of ['canvas','img[src*=qr]','[class*=qrcode]','[class*=qr-code]','iframe','form','input[type=password]','[class*=login]','button']) {
    const n = document.querySelectorAll(sel).length
    if (n) out.push(sel + ' × ' + n)
  }
  const cv = document.querySelector('canvas')
  if (cv) out.push('canvas 尺寸 ' + cv.width + 'x' + cv.height)
  return out.join(' | ')
})()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-login.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-login.png')
ws.close()
setTimeout(() => process.exit(0), 200)
