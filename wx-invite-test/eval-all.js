/**
 * 在所有 page 目标里执行同一段表达式，打印每个目标的探测结果。
 * 用法：node eval-all.js <urlPart> "<expr>"
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  return {
    ev: (expr) => new Promise((ok) => {
      const id = Math.floor(Math.random() * 1e9)
      const timer = setTimeout(() => { ok({ err: 'TIMEOUT' }) }, 8000)
      const on = e => {
        const m = JSON.parse(e.data)
        if (m.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', on)
        if (m.result?.exceptionDetails) return ok({ err: String(m.result.exceptionDetails.text || '').slice(0, 80) })
        ok({ v: m.result?.result?.value })
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    }),
    close: () => { try { ws.close() } catch { /* */ } }
  }
}

async function main() {
  const part = process.argv[2] || ''
  const expr = process.argv[3] || `(function(){return JSON.stringify({w:window.innerWidth,h:window.innerHeight,rows:document.querySelectorAll('tbody tr').length,bodyW:Math.round(document.body.getBoundingClientRect().width)})})()`
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    if (part && !t.url.includes(part)) continue
    const c = await connect(t)
    const r = await c.ev(expr)
    c.close()
    console.log(`[${i}] ${t.title.slice(0, 20)} | ${t.url.slice(0, 50)} => ${r.err ? 'ERR ' + r.err : r.v}`)
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
