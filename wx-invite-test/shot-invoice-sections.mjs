/** 滚动发票中心弹层，截图验证「多方向分组」显示（微信两个方向 / 抖店四个方向）。只读。 */
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
await sleep(1000)
if (!(await ev(`!!document.querySelector('[data-test=invoice-center-modal]')`))) {
  await ev(`document.querySelector('[data-test=invoice-center-open]').click()`)
  await sleep(2500)
}
// 面板里每个店铺一张卡片，逐张滚到可见并截图
const n = await ev(`document.querySelectorAll('[data-test=invoice-row]').length`)
console.log('店铺卡片数:', n)
const names = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-test=invoice-row]')].map(r => String((r.querySelector('b')||{}).innerText||'').trim()))`))
console.log('顺序:', names.join('、'))
for (let i = 0; i < n; i++) {
  await ev(`(() => { const r = document.querySelectorAll('[data-test=invoice-row]')[${i}]; if (r) r.scrollIntoView({block:'start'}); return 1 })()`)
  await sleep(900)
  const secs = JSON.parse(await ev(`(() => {
    const r = document.querySelectorAll('[data-test=invoice-row]')[${i}]
    if (!r) return '[]'
    return JSON.stringify([...r.querySelectorAll('[data-test=invoice-section]')].map(s => {
      const nm = String((s.querySelector('.inv-sec-name')||{}).innerText||'').trim()
      const cnt = String((s.querySelector('.row-sub')||{}).innerText||'').trim()
      const tbl = s.querySelector('[data-test=invoice-table]')
      return nm + ' | ' + cnt + ' | ' + (tbl ? tbl.querySelectorAll('tbody tr').length + ' 行' : '无表')
    }))
  })()`))
  console.log(`  [${i}] ${names[i]}:`, secs.join('  //  '))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`wx-invite-test/ui-invoice-store${i}.png`, Buffer.from(shot.data, 'base64'))
}
console.log('\n截图已存 ui-invoice-store0..N.png')
ws.close()
setTimeout(() => process.exit(0), 200)
