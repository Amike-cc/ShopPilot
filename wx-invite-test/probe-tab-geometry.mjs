/**
 * 复刻 findTextTarget 的候选筛选与落点采样，dump 微信发票页各方向页签的真实几何。
 * 目的：查清 clickByText 报 "被 unknown 遮挡" 的真实原因（落点全在视口外？零尺寸？被谁盖住？）
 * 只读。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const NEEDLE = process.argv[2] || '给平台开票'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('bill/home')).pop()
if (!pg) { console.log('没有 bill/home 页面'); process.exit(1) }
console.log('目标页面:', pg.url, '\n')

const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

const out = await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
  }
  const own = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const needle = ${JSON.stringify(NEEDLE)}
  const cands = []
  for (const el of all) {
    if (!own(el).includes(needle)) continue
    const r = el.getBoundingClientRect()
    cands.push({
      tag: el.tagName, cls: String(el.className || '').slice(0, 60),
      own: own(el).slice(0, 30), ownLen: own(el).length,
      vis: vis(el),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      inShadow: !!el.getRootNode().host,
      host: el.getRootNode().host ? el.getRootNode().host.tagName : null,
      style: (() => { const cs = getComputedStyle(el); return cs.position + '/' + cs.display + '/' + cs.visibility + '/op=' + cs.opacity + '/pe=' + cs.pointerEvents })()
    })
  }
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) },
    total: cands.length,
    cands
  }, null, 1)
})()`)
console.log(out)

// 对第一个可见候选做落点采样（与 findTextTarget 完全一致的采样点）
const probe = await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const vis = (el) => { const r = el.getBoundingClientRect(); if (!(r.width>0&&r.height>0)) return false; const cs = getComputedStyle(el); return cs.display!=='none'&&cs.visibility!=='hidden'&&cs.opacity!=='0' }
  const own = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const needle = ${JSON.stringify(NEEDLE)}
  const cands = all.filter(el => own(el).includes(needle) && vis(el))
  if (!cands.length) return 'no visible candidate'
  cands.sort((a,b) => own(a).length - own(b).length)
  const hit = cands[0]
  hit.scrollIntoView({ block: 'center' })
  const r = hit.getBoundingClientRect()
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner } return el }
  const desc = (el) => el ? el.tagName + '.' + String(el.className || '').slice(0, 50) + ' 「' + String(el.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 20) + '」' : 'null'
  const points = []
  const labelEl = hit.closest('label') || hit.parentElement || hit
  for (const fx of [0.12, 0.3, 0.5, 0.7, 0.88]) {
    for (const fy of [0.5, 0.25, 0.75]) {
      const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy)
      const at = deepAt(x, y)
      const match = at && (at === hit || hit.contains(at) || at.contains(hit) || labelEl.contains(at) || at.contains(labelEl))
      points.push({ x, y, at: desc(at), match: !!match })
    }
  }
  return JSON.stringify({
    hit: desc(hit),
    hitSelfOwn: own(hit),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: innerWidth, h: innerHeight },
    points,
    center: desc(deepAt(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)))
  }, null, 1)
})()`)
console.log('\n=== 落点采样 ===\n' + probe)

ws.close()
setTimeout(() => process.exit(0), 200)
