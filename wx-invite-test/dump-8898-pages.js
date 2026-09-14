/** 逐个 8898 页面看它到底是哪一版内容（标题/宿主元素/元素数/HTML 片段） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('8898'))) {
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
    const r = await send('Runtime.evaluate', {
      expression: `(function(){
        var d=document
        return JSON.stringify({
          url: location.href.slice(0,40),
          ready: d.readyState,
          w: window.innerWidth,
          title: d.title,
          hasStage: !!d.getElementById('stage'),
          hasApp: !!d.getElementById('app'),
          stageShadow: !!(d.getElementById('stage')&&d.getElementById('stage').shadowRoot),
          appShadow: !!(d.getElementById('app')&&d.getElementById('app').shadowRoot),
          els: d.querySelectorAll('*').length,
          body: String(d.body?d.body.innerHTML:'').replace(/\\s+/g,' ').slice(0,160)
        })
      })()`,
      returnByValue: true, awaitPromise: true
    })
    console.log(r.result?.value || JSON.stringify(r.exceptionDetails).slice(0, 200))
    ws.close()
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
