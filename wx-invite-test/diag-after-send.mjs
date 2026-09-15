/**
 * 看当前快手页面状态：抽屉是否还在、有没有二次确认框、有没有"发送成功"提示。
 * 用于判断刚那次「发送邀请」到底发出去了没有。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('没有达人广场页'); process.exit(1) }
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
console.log('地址:', await q(`location.href.slice(0,70)`))
console.log('视口:', await q(`innerWidth+'x'+innerHeight`))
console.log('\n=== 抽屉还在吗 ===')
console.log(await q(`(() => {
  const dr = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.position === 'fixed' && r.width > 400 && r.height > 200 })
  return dr.length ? 'still open: ' + String(dr[0].className||'').slice(0,60) : '(已关闭)'
})()`))
console.log('\n=== textarea 还在吗 ===')
console.log(await q(`(() => {
  const ts = [...document.querySelectorAll('textarea')].filter(t => t.getBoundingClientRect().width > 0)
  return ts.length ? ts.map(t => 'val="' + String(t.value||'').slice(0,24) + '"').join(' | ') : '(无可见 textarea)'
})()`))
console.log('\n=== 有没有二次确认弹窗 / 成功提示 ===')
console.log(await q(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (t.length > 60) continue
    if (!/确认发送|确认邀请|发送成功|邀约成功|已发送|失败|请选择/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push(t.slice(0,50) + '  <' + el.tagName + '.' + String(el.className||'').slice(0,40) + '>')
  }
  return [...new Set(out)].slice(0,10).join('\\n') || '(无相关提示)'
})()`))
console.log('\n=== 页面可见的 modal ===')
console.log(await q(`(() => {
  const ms = [...document.querySelectorAll('[class*=modal], [class*=Modal], [role=dialog]')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 200 && r.height > 100 && cs.display !== 'none' })
  return ms.length ? ms.map(e => String(e.className||'').slice(0,50) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)).join('\\n') : '(无)'
})()`))
console.log('\n=== 正文尾部（看提示） ===')
console.log(String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(-400)`)))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ks-after-real-send.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图: wx-invite-test/ks-after-real-send.png')
ws.close()
setTimeout(() => process.exit(0), 200)
