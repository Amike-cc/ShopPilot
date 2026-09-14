/** 判定：点击事件到底有没有派发到按钮上（装自己的监听器计数） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  console.log('装计数:', await ev(`(() => {
    window.__clicks = { synth: 0, real: 0, docSynth: 0 }
    const b = document.querySelector('[data-test=invite-start]')
    b.addEventListener('click', (e) => { window.__clicks[e.isTrusted ? 'real' : 'synth']++ })
    document.addEventListener('click', (e) => { if (!e.isTrusted) window.__clicks.docSynth++ }, true)
    return 'hooked'
  })()`))
  console.log('合成点击:', await ev(`(()=>{document.querySelector('[data-test=invite-start]').click();return 'ok'})()`))
  await sleep(800)
  const r = JSON.parse(await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');b.scrollIntoView({block:'center'});const q=b.getBoundingClientRect();return JSON.stringify({x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)})})()`))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  console.log('计数:', await ev(`JSON.stringify(window.__clicks)`))
  console.log('最新任务:', await ev(`(async()=>{const r=await window.shopilot.task.list();const all=Array.isArray(r.data)?r.data:[];const t=all.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];return JSON.stringify({name:t&&t.name,at:t&&new Date(t.createdAt).toLocaleTimeString()})})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
