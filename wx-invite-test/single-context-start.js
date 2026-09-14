/** 单次页面上下文内完成：填字段 → 读按钮态 → 点击 → 查最新任务（排除跨调用时序问题） */
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
  const out = await ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const setV = (sel, val, isText) => {
      const el = document.querySelector(sel)
      if (!el) return 'missing'
      const proto = isText ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value.length
    }
    const r = {}
    r.contact = setV('[data-test=invite-contact]', '测试联系人')
    r.wechat = setV('[data-test=invite-wechat]', 'test_wx_001')
    r.phone = setV('[data-test=invite-phone]', '13800000000')
    r.script = setV('[data-test=invite-script]', '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样。', true)
    r.ids = setV('[data-test=invite-product-ids]', '10000687986563', true)
    await sleep(800)
    const b = document.querySelector('[data-test=invite-start]')
    r.btnDisabled = b ? b.disabled : 'no-btn'
    r.btnDisabledAttr = b ? b.hasAttribute('disabled') : null
    const before = await window.shopilot.task.list()
    r.countBefore = (Array.isArray(before.data) ? before.data : []).length
    if (b) b.click()
    await sleep(3500)
    const after = await window.shopilot.task.list()
    const all = Array.isArray(after.data) ? after.data : []
    r.countAfter = all.length
    const newest = all.slice().sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0]
    r.newest = newest ? { name: newest.name, at: new Date(newest.createdAt).toLocaleTimeString(), steps: (newest.steps || []).map(z => z.type) } : null
    return JSON.stringify(r, null, 1)
  })()`)
  console.log(out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
