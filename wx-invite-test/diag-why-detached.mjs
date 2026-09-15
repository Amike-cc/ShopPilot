/**
 * 判定"视图为什么被摘"：依次尝试几种恢复手段，每步后测量快手页面视口。
 *  ① 直接再 display 一次
 *  ② setViewsObscured(false)（渲染层弹层遮挡标记）
 *  ③ setViewport 上报一次
 * 哪个能恢复 → 就是那个原因。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async u => (await fetch(u)).json()

async function ksViewport() {
  const l = await J(`http://127.0.0.1:${PORT}/json/list`)
  const out = []
  for (const p of l.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian'))) {
    try {
      const w = new WebSocket(p.webSocketDebuggerUrl)
      await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
      let s = 0; const pend = new Map()
      w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error('x')) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: `innerWidth+'x'+innerHeight`, returnByValue: true })
      out.push(String(p.id).slice(0, 6) + '=' + (r.result?.value || '?'))
      w.close()
    } catch { out.push(String(p.id).slice(0, 6) + '=ERR') }
  }
  return out.join(' ')
}

const app = (await J(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
console.log('快手 storeId:', ks.id)
console.log('① 初始:', await ksViewport())

console.log('\n② 再 display 一次…')
await ev(`(async()=>{await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)
console.log('   视口:', await ksViewport())

console.log('\n③ setViewsObscured(false)…')
console.log('   返回:', await ev(`(async()=>{const r=await window.shopilot.browser.setViewsObscured(false);return JSON.stringify(r)})()`))
await sleep(2500)
console.log('   视口:', await ksViewport())

console.log('\n④ setViewport 上报 776x818…')
await ev(`(async()=>{const r=await window.shopilot.browser.setViewport({x:0,y:0,width:900,height:800});return JSON.stringify(r)})()`)
await sleep(2500)
console.log('   视口:', await ksViewport())

console.log('\n⑤ 渲染层是否有"锁屏"覆盖层:', await ev("JSON.stringify({ lock: !!document.querySelector('[data-test=lock-screen], .lock-screen, [class*=lock]'), welcome: !!document.querySelector('.welcome') })"))
ws.close()
setTimeout(() => process.exit(0), 200)
