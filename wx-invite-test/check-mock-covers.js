/** 核对仿真页的遮挡层与 chip 坐标：谁盖住了谁 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const PROBE = `(function(){
  var host=document.getElementById('stage'); var root=host&&host.shadowRoot; if(!root) return JSON.stringify({err:'no shadow'})
  var hr=host.getBoundingClientRect()
  var out={hostOrigin:[Math.round(hr.left),Math.round(hr.top)],covers:[],chips:[],points:{}}
  var deep=function(x,y){var el=document.elementFromPoint(x,y);while(el&&el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner}return el}
  root.querySelectorAll('.cover').forEach(function(c){var r=c.getBoundingClientRect();out.covers.push({c:c.getAttribute('data-covers'),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})})
  root.querySelectorAll('#cats .chip').forEach(function(ch){var r=ch.getBoundingClientRect();var t=String(ch.textContent).trim()
    var hit=deep(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))
    out.chips.push({t:t,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],atCenter:hit?(hit.tagName+'.'+String(hit.className||'').slice(0,20)):null})})
  return JSON.stringify(out,null,1)
})()`

async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
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
    if (r.result?.value > 0) {
      return {
        ev: async (expr) => {
          const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
          if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
          return res.result.value
        },
        close: () => ws.close()
      }
    }
    ws.close()
  }
  return null
}
async function main() {
  const p = await pickLive('8898')
  if (!p) { console.log('no mock page'); process.exit(0) }
  console.log(await p.ev(PROBE))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
