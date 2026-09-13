/**
 * 极简 CDP 驱动：列出目标 / 在指定目标里执行 JS / 截图。
 * 用法：
 *   node cdp.js targets
 *   node cdp.js exec <targetIndexOrUrlPart> <jsFile|- >          （stdout 输出 JSON 结果）
 *   node cdp.js shot <targetIndexOrUrlPart> <out.png>
 *   node cdp.js wait <urlPart> <ms>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

async function json(path, opts) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`)
  return res.json()
}

async function targets() {
  const list = await json('/json/list')
  return list.filter(t => t.type === 'page' || t.type === 'webview' || t.type === 'iframe')
}

function pick(list, key) {
  if (/^\d+$/.test(key)) {
    const t = list[Number(key)]
    if (!t) throw new Error('index 越界: ' + key)
    return t
  }
  const t = list.find(x => x.url.includes(key) || x.title.includes(key))
  if (!t) throw new Error('找不到目标: ' + key + '\n' + list.map(x => `${x.title.slice(0, 30)} | ${x.url.slice(0, 80)}`).join('\n'))
  return t
}

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  return {
    send(method, params = {}) {
      return new Promise((ok, err) => {
        const id = ++seq
        pending.set(id, m => m.error ? err(new Error(method + ': ' + JSON.stringify(m.error))) : ok(m.result))
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* */ } }
  }
}

async function evalIn(t, expr) {
  const c = await connect(t)
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
    return r.result.value
  } finally { c.close() }
}

const [, , cmd, key, arg] = process.argv
;(async () => {
  if (cmd === 'targets') {
    const list = await targets()
    list.forEach((t, i) => console.log(`[${i}] ${t.type} | ${t.title.slice(0, 50)} | ${t.url.slice(0, 120)}`))
    return
  }
  if (cmd === 'exec') {
    const t = pick(await targets(), key)
    const expr = arg === '-' ? await readStdin() : arg
    const v = await evalIn(t, expr)
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
    return
  }
  if (cmd === 'shot') {
    const t = pick(await targets(), key)
    const c = await connect(t)
    try {
      const r = await c.send('Page.captureScreenshot', { format: 'png' })
      require('fs').writeFileSync(arg, Buffer.from(r.data, 'base64'))
      console.log('saved', arg)
    } finally { c.close() }
    return
  }
  if (cmd === 'wait') {
    for (let i = 0; i < Math.ceil(Number(arg || 30000) / 1000); i++) {
      const list = await targets()
      if (list.some(x => x.url.includes(key))) { console.log('ready'); return }
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('等待超时: ' + key)
  }
  console.log(__doc)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })

function readStdin() {
  return new Promise((ok) => {
    let d = ''
    process.stdin.on('data', c => d += c)
    process.stdin.on('end', () => ok(d))
  })
}
