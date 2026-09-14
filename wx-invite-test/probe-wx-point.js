/** 查 (x,y) 深处元素（穿透 ShadowRoot）+ 该处 label/input 的禁用与关联关系 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

const PROBE = (x, y) => `(function(){
  var px=${x}, py=${y}
  var el = document.elementFromPoint(px, py)
  var chain = []
  // 逐层深入 ShadowRoot
  while (el && el.shadowRoot) {
    var inner = el.shadowRoot.elementFromPoint(px, py)
    if (!inner || inner === el) break
    el = inner
  }
  var node = el
  for (var i = 0; i < 4 && node; i++) {
    chain.push({ tag: node.tagName, cls: String(node.className||'').slice(0,40), own: (function(){var s='';for(var k=0;k<node.childNodes.length;k++){var n=node.childNodes[k];if(n.nodeType===3)s+=n.textContent}return s.trim().slice(0,20)})(), disabled: node.disabled===true })
    node = node.parentElement
  }
  var lab = el ? el.closest('label') : null
  var inp = lab ? lab.querySelector('input') : (el && el.tagName==='INPUT' ? el : null)
  return JSON.stringify({
    deepest: chain[0] || null,
    chain: chain,
    labelCls: lab ? String(lab.className).slice(0,50) : null,
    labelText: lab ? String(lab.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20) : null,
    inputFound: !!inp,
    inputChecked: inp ? !!inp.checked : null,
    inputDisabled: inp ? !!inp.disabled : null,
    inputRect: inp ? (function(){var r=inp.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})() : null,
    labelHasFor: lab ? !!lab.getAttribute('for') : null
  })
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
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  console.log(await sq.ev(PROBE(587, 414)))
  console.log(await sq.ev(PROBE(300, 414)))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
