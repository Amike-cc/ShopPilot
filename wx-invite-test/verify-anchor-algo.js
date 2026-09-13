/**
 * 在页面里验证 readLabelValue 的取数算法：对每个标签找出值并打印（含卡片文本、出现次数）。
 * 用法：node verify-anchor-algo.js <urlPart> <label1> <label2> ...
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const DEEP = process.argv.includes('--deep')
const argv = process.argv.slice(2).filter(a => a !== '--deep')
const urlPart = argv[0] || 'syt.kwaixiaodian'
const labels = argv.slice(1)
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
async function main() {
  const page = (await targets()).find(t => t.url.includes(urlPart))
  if (!page) throw new Error('目标页未找到: ' + urlPart)
  const c = await connect(page)
  const out = await c.ev(`(() => {
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const DEEP = ${DEEP ? 'true' : 'false'}
    const all = () => {
      const out = []
      const walk = root => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      return out
    }
    const scope = DEEP ? all() : [...document.querySelectorAll('*')]
    const LABELS = ${JSON.stringify(labels.length ? labels : ['成交金额', '成交订单数', '退款金额（支付日）', '退款订单数（支付日）'])}
    const res = []
    for (const label of LABELS) {
      const cands = []
      for (const el of scope) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        if (!own.includes(label)) continue
        if (!visible(el)) continue
        cands.push({ el, len: own.length, exact: own === label })
      }
      cands.sort((a, b) => (b.exact - a.exact) || (a.len - b.len))
      if (!cands.length) { res.push({ label, value: null, why: 'NOT_FOUND' }); continue }
      let node = cands[0].el
      let value = null, cardText = null, why = 'NO_VALUE_SIBLING'
      for (let i = 0; i < 6 && node && node !== document.body; i++) {
        const txt = clean(node.innerText || node.textContent || '')
        if (txt.length > label.length) {
          const v = txt.replace(label, '').trim()
          if (v && v.length <= 40) { value = v; cardText = txt.slice(0, 60); why = 'ok'; break }
          if (v && v.length > 40) { why = 'VALUE_TOO_LONG:' + txt.slice(0, 40); break }
        }
        node = node.parentElement || (node.getRootNode && node.getRootNode().host)
      }
      res.push({ label, candidates: cands.length, value, cardText, why })
    }
    return JSON.stringify({ url: location.href.slice(0, 70), deep: DEEP, res }, null, 1)
  })()`)
  console.log(out)
  c.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
