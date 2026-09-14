/** 找列表行里能标识达人的东西：data-row-key / href / 内嵌的 v2_ finderUsername */
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
      return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
    }
    ws.close()
  }
  return null
}
async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('没有活跃广场页'); process.exit(0) }
  console.log(await sq.ev(`(() => {
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const rows = all.filter(el => el.tagName === 'TR')
    const info = rows.slice(0, 4).map(tr => ({
      attrs: [...tr.attributes].map(a => a.name + '=' + String(a.value).slice(0, 60)),
      html: String(tr.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 700)
    }))
    // 页面上出现的 finderUsername 片段
    const html = String(document.body ? document.body.innerHTML : '')
    const usernames = [...new Set((html.match(/v2_[0-9a-zA-Z]{6,}/g) || []).slice(0, 5))]
    // 含 href 的元素
    const hrefs = [...new Set(all.filter(e => e.tagName === 'A' && e.getAttribute('href') && !String(e.getAttribute('href')).startsWith('javascript')).map(e => String(e.getAttribute('href')).slice(0, 80)))].slice(0, 8)
    return JSON.stringify({ rows: info, usernames, hrefs }, null, 1)
  })()`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
