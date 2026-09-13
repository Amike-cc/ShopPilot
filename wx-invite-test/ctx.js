/**
 * 在指定目标里列出 frame 树与执行上下文，并可在指定 frame 上下文中执行 JS。
 * 用法：
 *   node ctx.js frames <urlPart>                     列出 frames + contexts
 *   node ctx.js frame-exec <urlPart> <frameUrlPart> <jsFile|- >
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function main() {
  const [, , cmd, key, frameKey, jsArg] = process.argv
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find(x => (x.url + x.title).includes(key))
  if (!t) throw new Error('no target: ' + key)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  const events = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method) events.push(m)
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(method + ' ' + JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1200)
  const ctxs = events.filter(m => m.method === 'Runtime.executionContextCreated')
    .map(m => m.params.context)

  if (cmd === 'frames') {
    const ft = await send('Page.getFrameTree')
    const frames = []
    const walk = f => { frames.push({ id: f.frame.id, url: f.frame.url.slice(0, 140) }); (f.childFrames || []).forEach(walk) }
    walk(ft.frameTree)
    console.log('FRAMES:', JSON.stringify(frames, null, 1))
    console.log('CONTEXTS:', JSON.stringify(ctxs.map(c => ({ id: c.id, origin: c.origin.slice(0, 90), name: c.name })), null, 1))
    ws.close(); return
  }
  if (cmd === 'frame-exec') {
    const ft = await send('Page.getFrameTree')
    const frames = []
    const walk = f => { frames.push(f.frame); (f.childFrames || []).forEach(walk) }
    walk(ft.frameTree)
    const fr = frames.find(f => f.url.includes(frameKey))
    if (!fr) throw new Error('no frame: ' + frameKey + '\n' + frames.map(f => f.url.slice(0, 100)).join('\n'))
    const ctx = ctxs.find(c => c.id && (c.origin.includes(frameKey) || (c.name || '').includes(frameKey)))
      || ctxs.find(c => c.origin.includes(new URL(fr.url).origin))
    if (!ctx) throw new Error('no context for frame ' + frameKey + '; have: ' + ctxs.map(c => c.origin).join(' | '))
    const expr = jsArg === '-' ? await readStdin() : jsArg
    const r = await send('Runtime.evaluate', {
      expression: expr, contextId: ctx.id, awaitPromise: true, returnByValue: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error('frame 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 800))
    const v = r.result.value
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
    ws.close(); return
  }
  ws.close()
}

function readStdin() {
  return new Promise(ok => { let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => ok(d)) })
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
