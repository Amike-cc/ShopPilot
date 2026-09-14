/** 决定性测试：Proxy 数组 vs 纯数组，过 IPC 分别结果如何（确认 startInvite 是否也被同一坑拦住） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}

console.log('① 纯数组 → prepareInviteSquare:', await ev(`(async () => {
  try {
    const r = await window.shopilot.browser.prepareInviteSquare('${STORE}', { url: 'https://store.weixin.qq.com/shop/findersquare/find', finderType: '直播带货者', categories: ['母婴'], otherFilters: [] })
    return JSON.stringify({ ok: r.ok })
  } catch (e) { return 'THREW ' + e.message }
})()`))

console.log('② Proxy 数组 → prepareInviteSquare:', await ev(`(async () => {
  try {
    const proxyCats = new Proxy(['母婴'], {})
    const r = await window.shopilot.browser.prepareInviteSquare('${STORE}', { url: 'https://store.weixin.qq.com/shop/findersquare/find', finderType: '直播带货者', categories: proxyCats, otherFilters: new Proxy([], {}) })
    return JSON.stringify({ ok: r.ok })
  } catch (e) { return 'THREW ' + e.message }
})()`))

console.log('③ Proxy 数组 → task.create:', await ev(`(async () => {
  try {
    const proxyCats = new Proxy(['母婴'], {})
    const r = await window.shopilot.task.create({ name: '探测 · Proxy步骤', storeScope: '${STORE}', steps: [
      { type: 'navigate', input: { url: 'https://store.weixin.qq.com/shop/findersquare/find' } },
      { type: 'clickByText', input: { text: proxyCats[0], deep: true, mode: 'real' } },
      { type: 'clickByText', input: { text: 'x', deep: true, mode: 'real', followTab: { urlIncludes: 'v' } } }
    ]})
    return JSON.stringify({ ok: r.ok, err: r.error && r.error.message })
  } catch (e) { return 'THREW ' + e.message }
})()`))

console.log('④ 把 Proxy 塞进 input 数组字段 → task.create:', await ev(`(async () => {
  try {
    const proxyCats = new Proxy(['母婴'], {})
    const r = await window.shopilot.task.create({ name: '探测 · Proxy数组字段', storeScope: '${STORE}', steps: [
      { type: 'navigate', input: { url: 'https://store.weixin.qq.com/shop/findersquare/find' } },
      { type: 'clickByText', input: { text: '详情', deep: true, mode: 'real', nth: 'unvisited', missingCode: 'TASK_PAGE_EXHAUSTED' } },
      { type: 'requireQuota', input: { textIncludes: '今日剩余', min: 1, deep: true } }
    ], meta: { cats: proxyCats } })
    return JSON.stringify({ ok: r.ok, err: r.error && r.error.message })
  } catch (e) { return 'THREW ' + e.message }
})()`))

setTimeout(() => process.exit(0), 400)
