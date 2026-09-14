/** 从表格行的 Vue 组件数据里取 finderUsername（可绕过点击固定列副本的问题） */
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
    const out = []
    const findUser = (obj, depth) => {
      if (!obj || depth > 4) return null
      if (typeof obj === 'string') return /^v2_[0-9a-zA-Z]{10,}$/.test(obj) ? obj : null
      if (typeof obj !== 'object') return null
      for (const k of Object.keys(obj)) {
        if (/finderUsername|username|finder_username/i.test(k) && typeof obj[k] === 'string') return obj[k]
      }
      for (const k of Object.keys(obj)) {
        const v = findUser(obj[k], depth + 1)
        if (v) return v
      }
      return null
    }
    const all = []
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const rows = all.filter(el => el.tagName === 'TR' && el.querySelector('td'))
    for (const tr of rows.slice(0, 3)) {
      const keys = Object.keys(tr).filter(k => /^__vue|^__react|^_v/.test(k))
      const detail = keys.map(k => ({ k, kind: typeof tr[k], keys2: tr[k] && typeof tr[k] === 'object' ? Object.keys(tr[k]).slice(0, 25) : null }))
      let found = null, via = null
      for (const k of keys) {
        const comp = tr[k]
        if (!comp || typeof comp !== 'object') continue
        try { found = findUser(comp, 0) } catch (e) { found = 'ERR:' + e.message }
        if (found) { via = k; break }
      }
      out.push({ keys, detail, via, username: found, text: String(tr.innerText || '').replace(/\\s+/g, ' ').slice(0, 40) })
    }
    return JSON.stringify(out, null, 1)
  })()`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
