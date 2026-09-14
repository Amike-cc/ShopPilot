/**
 * 读取 initiate-invite 页当前可见弹窗状态（可见弹窗内：搜索框、复选框、按钮、商品行）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find(x => x.url.includes('initiate-invite'))
  if (!t) throw new Error('initiate-invite 页不在打开的目标里')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(method + ' ' + JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const sr = document.querySelector('micro-app').shadowRoot
      const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
      const wrps = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')].map(d => {
        const r = d.getBoundingClientRect()
        const st = getComputedStyle(d)
        return {
          size: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          display: st.display, vis: r.width > 0 && st.display !== 'none' && st.visibility !== 'hidden',
          text: clean(d.textContent).slice(0, 200)
        }
      })
      const vis = wrps.filter(w => w.vis)
      const out = { wrpCount: wrps.length, vis }
      if (vis.length) {
        const d = [...sr.querySelectorAll('.weui-desktop-dialog__wrp')][wrps.indexOf(vis[0])]
        const inputs = [...d.querySelectorAll('input')].map(i => ({ ph: i.placeholder, rect: [Math.round(i.getBoundingClientRect().left), Math.round(i.getBoundingClientRect().top), Math.round(i.getBoundingClientRect().width)] }))
        const btns = [...d.querySelectorAll('button')].map(b => ({ t: clean(b.textContent).slice(0, 12), rect: [Math.round(b.getBoundingClientRect().left), Math.round(b.getBoundingClientRect().top)], dis: String(b.className).includes('disabled') }))
        const rows = [...d.querySelectorAll('tbody tr')].map(tr => clean(tr.textContent).slice(0, 80))
        out.inputs = inputs; out.btns = btns; out.rows = rows
      }
      return JSON.stringify(out, null, 1)
    })()`,
    returnByValue: true
  })
  console.log(r.result.value)
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
