/** 检查 invite-start 按钮数量与可见性，以及面板当前分支内容 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  console.log(await ev(`(() => {
    const btns = [...document.querySelectorAll('[data-test=invite-start]')].map(b => {
      const r = b.getBoundingClientRect()
      return { text: String(b.innerText||'').trim(), disabled: !!b.disabled, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], visible: r.width > 0 && r.height > 0 }
    })
    const panel = document.querySelector('[data-test=invite-panel]')
    const cards = panel ? [...panel.querySelectorAll('.inv-card-h')].map(h => String(h.innerText||'').replace(/\\s+/g,' ').trim()) : []
    const hasWechatFields = !!document.querySelector('[data-test=invite-contact]') && !!document.querySelector('[data-test=invite-wechat]')
    const hasBatchFields = !!document.querySelector('[data-test=invite-category]')
    return JSON.stringify({ startButtons: btns, cards, hasWechatFields, hasBatchFields, panelVisible: panel ? getComputedStyle(panel).display : 'absent' }, null, 1)
  })()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
