/**
 * 在广场页核实筛选是否真的应用（找「已筛选」/选中 chip），并顺带查 toast 容器
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const sqT = targets.find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (!sqT) { console.log('没有广场页'); process.exit(0) }
const ws = new WebSocket(sqT.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('URL:', String(sqT.url).slice(0, 90))
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  // 任何含「已筛选」的文本
  const screenHits = [...new Set(all.map(el => own(el)).filter(t => /已筛选|筛选：|筛选:/.test(t)).map(t => t.slice(0, 120)))]
  // 顶部 chip 区：找与筛选有关的短文本
  const chipWords = ['直播带货者', '短视频带货者', '公众号带货者', '全部带货者', '母婴', '有联系方式']
  const chipState = {}
  for (const w of chipWords) {
    const el = all.find(e => own(e) === w && e.getBoundingClientRect().width > 0)
    if (!el) { chipState[w] = 'none'; continue }
    // 自身/父/祖父 class 是否带选中态
    const cls = [el, el.parentElement, el.parentElement && el.parentElement.parentElement].map(x => String((x && x.className) || '')).join(' | ')
    chipState[w] = /(current|active|checked|selected|on\b)/i.test(cls) ? 'selected' : 'plain'
  }
  // 表格行数（有数据说明筛选后仍有结果）
  const rows = all.filter(e => e.tagName === 'TR').length
  const details = all.filter(e => own(e) === '详情').length
  return JSON.stringify({ 已筛选文本: screenHits, chip状态: chipState, tr行: rows, 详情数: details, 正文片段: txt.slice(0, 150) }, null, 1)
})()`))
ws.close()
setTimeout(() => process.exit(0), 300)
