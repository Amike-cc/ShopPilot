/**
 * 从「邀约详情」（invite-detail）页里找**达人详情页**入口，用来量"已邀约达人"的详情页状态。
 * 用法：node wx-invite-test/probe-invite-detail-links.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { ev, close: () => ws.close() }
}

const DUMP = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const hrefs = [...new Set(all.filter(e => e.getAttribute && e.getAttribute('href')).map(e => String(e.getAttribute('href')).slice(0, 120)))].slice(0, 12)
  const buttons = [...new Set(all.filter(e => vis(e) && own(e) && own(e).length <= 12 && (e.tagName === 'BUTTON' || e.tagName === 'A')).map(e => own(e)))].slice(0, 20)
  const text = all.map(e => own(e)).filter(Boolean).join(' ').replace(/\\s+/g, ' ')
  return JSON.stringify({ path: location.pathname, hrefs, buttons, hasFinderDetail: text.includes('带货者详情') || text.includes('达人主页'), head: text.slice(0, 200) })
})()`

const list = await targets()
const page = list.find(t => /invite-detail/.test(String(t.url)))
if (!page) { console.error('没有 invite-detail 目标'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 10; i++) {
  const raw = await conn.ev(DUMP).catch(() => null)
  if (raw) { const d = JSON.parse(raw); if (d.buttons.length) { console.log(JSON.stringify(d, null, 1)); break } }
  await sleep(2000)
}
conn.close()
process.exit(0)
