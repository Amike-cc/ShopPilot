/** 验证面板「开始邀约」是否也被 Proxy-over-IPC 拦住（只建任务、跑之前立刻取消；或直接看异常） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const page = targets.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
const events = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') events.push(JSON.stringify(m.params.exceptionDetails).slice(0, 260))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 260))
}
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
await send('Runtime.enable')

// 进面板
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)

// 直接模拟 startInvite 的关键一步：把面板状态构造成步骤再 task.create（不 run）
console.log('模拟 task.create（步骤里带面板的响应式数组）:', await ev(`(async () => {
  try {
    const r = await window.shopilot.task.create({ name: '探测 · Proxy 克隆', storeScope: '${STORE}', steps: [
      { type: 'navigate', input: { url: 'https://store.weixin.qq.com/shop/findersquare/find' } },
      { type: 'clickByText', input: { text: (document.querySelector('[data-test=invite-finder-category-母婴]')||{}).value || '母婴', deep: true, mode: 'real' } }
    ]})
    return JSON.stringify({ ok: r.ok, err: r.error && r.error.message })
  } catch (e) { return 'THREW ' + e.message }
})()`))

console.log('\n同一份数据，但先转纯对象:', await ev(`(async () => {
  const cats = [...document.querySelectorAll('[data-test^=invite-finder-category-]')].filter(e => e.checked).map(e => e.value)
  try {
    const r = await window.shopilot.task.create({ name: '探测 · 纯数组', storeScope: '${STORE}', steps: [
      { type: 'navigate', input: { url: 'https://store.weixin.qq.com/shop/findersquare/find' } },
      { type: 'clickByText', input: { text: cats[0] || '母婴', deep: true, mode: 'real' } }
    ]})
    return JSON.stringify({ ok: r.ok, err: r.error && r.error.message, cats })
  } catch (e) { return 'THREW ' + e.message }
})()`))

// 用真实 Proxy 数组试试（从 Vue 面板里拿）
console.log('\n用 Vue 面板真实的响应式数组过 IPC:', await ev(`(async () => {
  const el = document.querySelector('[data-test^=invite-finder-category-]')
  if (!el) return 'no-el'
  // 触发 Vue 的 v-model 让它持有 Proxy，再尝试把整个 DOM 上的 checked 集合塞进步骤
  const checked = [...document.querySelectorAll('[data-test^=invite-finder-category-]')].filter(e => e.checked)
  return 'checked=' + checked.length
})()`))

console.log('\n控制台异常:', JSON.stringify(events.slice(-6), null, 1))
console.log('toast:', await ev(`JSON.stringify([...document.querySelectorAll('[class*=toast],[role=alert]')].map(e=>String(e.innerText||'').trim()).filter(Boolean))`))
setTimeout(() => process.exit(0), 300)
