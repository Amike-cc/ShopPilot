/** 直接读邀约面板当前输入框里的值（不依赖已保存的配置键） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 打开店铺窗口 → 选微信店铺 → 切「任务」页签 → 选「达人邀约」子页签
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tab, .subtab, [class*=sub-tab]')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1500)

console.log(await ev(`(() => {
  const box = document.querySelector('[data-test=invite-start]') && document.querySelector('[data-test=invite-start]').closest('section,div')
  const scope = box ? box.parentElement || document.body : document.body
  const vals = [...document.querySelectorAll('input,textarea,select')].filter(e => e.offsetParent !== null)
    .map(e => ({ tag: e.tagName, ph: e.getAttribute('placeholder') || null, id: e.id || null, testid: e.getAttribute('data-test') || null, value: String(e.value || '').slice(0, 40) }))
  const btn = document.querySelector('[data-test=invite-start]')
  return JSON.stringify({ 面板输入: vals, 按钮: btn ? { disabled: btn.disabled, text: String(btn.innerText||'').trim() } : null }, null, 1)
})()`))
ws.close()
process.exit(0)
