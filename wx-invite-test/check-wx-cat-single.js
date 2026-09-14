/** 真实广场：再点一次「美妆护肤」，看 母婴 是否被取消（判断类目是单选还是多选） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const READ = [
  'var all=ENUM_ALL()',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var own=function(e){var out="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)out+=n.textContent}return out.trim()}',
  'var out={}',
  'for(var i=0;i<all.length;i++){var el=all[i];if(el.tagName!=="INPUT"||el.type!=="checkbox")continue;var lab=el.closest("label");if(!lab)continue;var t=text(lab);if(t==="\\u6bcd\\u5a74"||t==="\\u7f8e\\u5986\\u62a4\\u80a4"||t==="\\u6709\\u8054\\u7cfb\\u65b9\\u5f0f")out[t]=!!el.checked}',
  'var coord={}',
  'for(var j=0;j<all.length;j++){var e2=all[j];var o2=own(e2);if(o2==="\\u7f8e\\u5986\\u62a4\\u80a4"){var r=e2.getBoundingClientRect();if(r.width>0&&r.height>0){coord={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}}}',
  'return JSON.stringify({before:out,coord:coord})'
].join('\n')

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
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return {
          send,
          ev: async (expr, awaitP = true) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP, userGesture: true })
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
            return res.result.value
          },
          close: () => ws.close()
        }
      }
    } catch { /* next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  const before = JSON.parse(await sq.ev(`${ENUM_DECL}\n;(function(){\n${READ}\n})()`, false))
  console.log('before:', JSON.stringify(before))
  const c = before.coord
  if (!c || !c.x) { console.log('未定位到 美妆护肤'); process.exit(1) }
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'none' })
  await sleep(300)
  await sq.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await sq.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await sleep(2000)
  const after = JSON.parse(await sq.ev(`${ENUM_DECL}\n;(function(){\n${READ}\n})()`, false))
  console.log('after :', JSON.stringify(after.before))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
