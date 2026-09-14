/**
 * 把面板里的商家联系方式改成真实值并保存（模拟真人输入：设值 + 派发 input/change，触发 v-model 与防抖保存）。
 * 用法：node set-panel-contact.js --contact=刘涛 --wechat=jiaoe988 --phone=15057937334
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)=?(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, true] }))
const C = String(args.contact || ''), W = String(args.wechat || ''), P = String(args.phone || '')
if (!C || !W || !P) { console.error('需要 --contact / --wechat / --phone'); process.exit(2) }

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

// 打开店铺 + 选微信店铺 + 切到任务/达人邀约页签（面板元素要存在才能设值）
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tab, .subtab, [class*=sub-tab]')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1500)

console.log('设置结果:', await ev(`(() => {
  const put = (testid, val) => {
    const el = document.querySelector('[data-test=' + testid + ']')
    if (!el) return { testid, ok: false, why: 'no-el' }
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { testid, ok: true, value: el.value }
  }
  return JSON.stringify([put('invite-contact', ${JSON.stringify(C)}), put('invite-wechat', ${JSON.stringify(W)}), put('invite-phone', ${JSON.stringify(P)})])
})()`))

// 等防抖保存（面板是 debounce 落库）
await sleep(3500)
console.log('已保存的配置:', await ev(`(async()=>{
  const r = await window.shopilot.settings.get('invite.config.微信小店')
  const v = r && r.data && r.data.value
  if (!v) return '(空)'
  const o = typeof v === 'string' ? JSON.parse(v) : v
  return JSON.stringify({ contact: o.contact, wechat: o.wechat, phone: o.phone })
})()`))
console.log('面板当前值:', await ev(`(() => ['invite-contact','invite-wechat','invite-phone'].map(t => { const e = document.querySelector('[data-test=' + t + ']'); return t + '=' + (e ? e.value : '?') }).join(' | '))()`))
ws.close()
process.exit(0)
