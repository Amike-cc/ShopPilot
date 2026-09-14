/**
 * 决定性实验：对「详情」发真实鼠标点击（CDP Input，isTrusted），
 * 捕获 window.open / history.pushState / replaceState / 点击落点，判断平台到底怎么跳转。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
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
      return { send, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close(), url: t.url }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq || sq.url.includes('finder-detail')) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    console.log('匹配到的不是广场页，当前标签：')
    for (const t of list.filter(x => x.type === 'page')) console.log(' -', t.url.slice(0, 120))
    if (!sq) process.exit(0)
  }
  console.log('URL', sq.url, 'W', await sq.ev('window.innerWidth'))
  // 1) 装探针
  console.log(await sq.ev(`(() => {
    window.__log = []
    const o = window.open
    window.open = function (...a) { window.__log.push(['open', String(a[0])]); return o.apply(this, a) }
    for (const m of ['pushState', 'replaceState']) {
      const f = history[m]
      history[m] = function (...a) { window.__log.push([m, String(a[2])]); return f.apply(this, a) }
    }
    document.addEventListener('click', e => {
      const t = e.target
      window.__log.push(['click', t && t.tagName + '.' + String(t.className || '').slice(0, 40), e.isTrusted ? 'trusted' : 'synth', e.defaultPrevented ? 'prevented' : 'ok'])
    }, true)
    return 'probe installed, start url=' + location.href
  })()`))
  // 2) 列详情元素 + 中心点最上层元素
  console.log(await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i } return el }
    const out = []
    const hits = all.filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0)
    for (const el of hits.slice(0, 6)) {
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      const top = deepAt(x, y)
      out.push({
        tag: el.tagName + '.' + String(el.className || '').slice(0, 30),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        point: [x, y], inViewport: r.top > 0 && r.bottom < innerHeight,
        topmost: top ? top.tagName + '.' + String(top.className || '').slice(0, 40) : null,
        same: top === el || (top && el.contains(top)) || (top && top.contains(el)) ? 'SELF' : 'OTHER'
      })
    }
    return JSON.stringify({ count: hits.length, out }, null, 1)
  })()`))
  // 3) 真实点击第一个可见的 详情 点
  const pt = await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const hits = all.filter(el => own(el) === '详情')
    for (const el of hits) {
      const r = el.getBoundingClientRect()
      if (r.top > 80 && r.bottom < innerHeight - 10 && r.right < innerWidth) return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
    }
    return null
  })()`)
  console.log('点击点', pt)
  if (pt) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await sq.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
      await sleep(60)
    }
    await sleep(1800)
  }
  console.log(await sq.ev(`JSON.stringify({ url: location.href, log: window.__log }, null, 1)`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
