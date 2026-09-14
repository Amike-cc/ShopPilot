/** 用真实鼠标点击「开始邀约」（先滚动到可见），看是否创建任务 */
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
  // 滚动到按钮
  const pos = JSON.parse(await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'null';b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})})()`))
  console.log('按钮坐标:', JSON.stringify(pos))
  if (!pos || !pos.x) { console.log('没找到按钮'); process.exit(1) }
  await sleep(600)
  const pos2 = JSON.parse(await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:!!b.disabled})})()`))
  console.log('滚动后:', JSON.stringify(pos2))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos2.x, y: pos2.y, button: 'none' })
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 })
  console.log('真实点击完成')
  await sleep(5000)
  console.log('最新任务:', await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    const t = all.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
    return JSON.stringify({ name: t && t.name, createdAt: t && new Date(t.createdAt).toLocaleTimeString(), stepTypes: t ? (t.steps||[]).map(x=>x.type) : null, run: t && t.latestRun ? {status:t.latestRun.status, code:t.latestRun.errorCode, msg:t.latestRun.errorMessage?String(t.latestRun.errorMessage).slice(0,150):null} : null })
  })()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
