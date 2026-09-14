/** 检查按钮是否为活的 Vue 节点（_vei/_vnode/Vue 属性），并尝试多种点击方式 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = async (expr) => (await new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  }))
  console.log(await ev(`(() => {
    const b = document.querySelector('[data-test=invite-start]')
    if (!b) return 'no-btn'
    const keys = Object.keys(b).filter(k => /^_|vue|Vue/.test(k))
    const hasVei = !!(b._vei || b.__vei)
    const vnode = b.__vnode || b._vnode
    const panel = b.closest('[data-test=invite-panel]')
    const panelKeys = panel ? Object.keys(panel).filter(k => /^_|vue|Vue/.test(k)) : []
    return JSON.stringify({
      tag: b.tagName, txt: String(b.innerText||'').trim(),
      isConnected: b.isConnected, parentTag: b.parentElement && b.parentElement.tagName,
      vueKeys: keys, hasVei, vnodeType: vnode ? String(vnode.type && (vnode.type.__name || vnode.type.name || vnode.type)) : null,
      panelVueKeys: panelKeys,
      btnCount: document.querySelectorAll('[data-test=invite-start]').length,
      panelCount: document.querySelectorAll('[data-test=invite-panel]').length
    }, null, 1)
  })()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
