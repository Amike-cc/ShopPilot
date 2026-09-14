/** 看面板里的微信邀约配置是否还在（登录后要能直接点开始邀约） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log('微信邀约配置:', await ev(`(async()=>{
  const r = await window.shopilot.settings.get('invite.config.微信小店')
  const v = r && r.data && r.data.value
  if (!v) return '（没有保存的配置）'
  const o = typeof v === 'string' ? JSON.parse(v) : v
  return JSON.stringify({
    contact: o.contact, wechat: o.wechat, phone: o.phone,
    script: String(o.script || '').slice(0, 30), productIds: o.productIds, productCount: o.productCount,
    finderType: o.finderType, finderCategories: o.finderCategories, finderOtherFilters: o.finderOtherFilters
  })
})()`))
console.log('今日待办任务数:', await ev(`(async()=>{const r=await window.shopilot.task.list();return String((Array.isArray(r.data)?r.data:[]).length)})()`))
ws.close()
process.exit(0)
