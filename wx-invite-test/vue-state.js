/**
 * 挖 initiate-invite 页 Vue 组件树里与邀约表单相关的状态（定位「发送邀约」按钮的禁用条件）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = list.find(x => x.url.includes('initiate-invite'))
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
  const expr = `(() => {
    const sr = document.querySelector('micro-app').shadowRoot
    const host = sr.querySelector('div#app') || sr.querySelector('div')
    const app = host.__vue_app__
    if (!app) return 'no vue app'
    const found = []
    const seen = new Set()
    const walk = (inst, depth) => {
      if (!inst || depth > 25 || seen.has(inst)) return
      seen.add(inst)
      const ss = inst.setupState || {}
      const keys = Object.keys(ss)
      const interesting = keys.filter(k => /phone|contact|wechat|wx|invite|goods|product|disable|check|form|script|remark|desc/i.test(k))
      if (interesting.length) {
        const snapshot = {}
        for (const k of interesting) {
          try {
            const v = ss[k]
            if (v === null || v === undefined) { snapshot[k] = String(v); continue }
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') snapshot[k] = v
            else if (Array.isArray(v)) snapshot[k] = ('arr[' + v.length + ']')
            else snapshot[k] = ('obj:' + Object.keys(v).slice(0, 8).join(','))
          } catch (e) { snapshot[k] = 'ERR' }
        }
        found.push({ name: inst.type && (inst.type.name || inst.type.__name), keys: interesting, snapshot })
      }
      const sub = inst.subTree
      const walkVnode = (vn, d) => {
        if (!vn || d > 40) return
        if (vn.component) walk(vn.component, depth + 1)
        if (Array.isArray(vn.children)) for (const c of vn.children) walkVnode(c, d + 1)
        if (vn.suspense) { /* skip */ }
      }
      walkVnode(sub, 0)
    }
    walk(app._instance, 0)
    return JSON.stringify(found.slice(0, 12), null, 1).slice(0, 5000)
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  if (r.exceptionDetails) console.error('EXC', JSON.stringify(r.exceptionDetails).slice(0, 500))
  else console.log(r.result.value)
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
