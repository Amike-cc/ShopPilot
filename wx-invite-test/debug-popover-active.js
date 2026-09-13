/** hover 个护家清 chip 后，dump 所有级联弹层的文档顺序/类名/首两项，找"活跃"标记 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  let c = null
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('daren-square'))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) { c = { send }; break }
    ws.close()
  }
  if (!c) throw new Error('no live page')
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const chip = JSON.parse(await ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const row=[...document.querySelectorAll('label,div,span')].find(e=>own(e)==='\u4e3b\u63a8\u7c7b\u76ee');const item=row&&row.closest('.auxo-form-item-row');const a=[...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].find(x=>own(x.querySelector('.auxo-space-item span')||x)==='\u4e2a\u62a4\u5bb6\u6e05');const r=a.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`))
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chip.x, y: chip.y, button: 'none' })
  await sleep(1200)
  const dump = JSON.parse(await ev(`(()=>{const pops=[...document.querySelectorAll('.quick-filter-cascader-popover')];return JSON.stringify(pops.map((p,i)=>{const r=p.getBoundingClientRect();const menu=p.querySelector('.auxo-cascader-menu');const lis=menu?[...menu.querySelectorAll('li.auxo-cascader-menu-item')]:[];return {i,x:Math.round(r.left),y:Math.round(r.top),cls:String(p.className).replace('auxo-cascader-menus quick-filter-cascader-popover','').trim(),first:lis[0]?String(lis[0].innerText||'').trim():null,second:lis[1]?String(lis[1].innerText||'').trim():null}}))})()`))
  console.log(JSON.stringify(dump, null, 1))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
