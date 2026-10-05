/**
 * 真机验证：达人邀约面板现在**有商品ID/商品数量的输入框**，并且：
 *   ① 微信小店：商品ID 框里带出已保存的值（证明字段接上了配置，不是摆设）；
 *   ② 快手小店：有「邀约商品数量」框；
 *   ③ 改一下 → 保存 → 读回设置，确认真的写进去了（验完还原原值）。
 *
 * 用法：node wx-invite-test/verify-invite-product-fields.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const WX = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const KS = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到渲染层'); process.exit(1) }
const app = await connect(renderer)

/** 切到某店铺 + 打开达人邀约子页签，然后把面板字段读出来 */
const openPanel = async (storeId) => {
  await app.call(`window.shopilot.browser.display(${JSON.stringify(storeId)})`)
  await sleep(2500)
  const opened = await app.ev(`(() => {
    // 侧栏「达人邀约」子页签（按文案找按钮）
    const all = [...document.querySelectorAll('button, a, [role="tab"], div')]
    const el = all.find(e => { const t = String(e.textContent || '').trim(); const r = e.getBoundingClientRect(); return t === '达人邀约' && r.width > 0 && r.height > 0 })
    if (!el) return 'no-tab'
    ;(el.closest('button,a,[role="tab"]') || el).click()
    return 'clicked'
  })()`)
  await sleep(2500)
  return opened
}

const readFields = () => app.ev(`(() => {
  const g = s => { const el = document.querySelector(s); return el ? { exists: true, value: String(el.value || ''), placeholder: String(el.getAttribute('placeholder') || ''), type: String(el.getAttribute('type') || '') } : { exists: false } }
  const labels = [...document.querySelectorAll('.invite-field > span')].map(e => String(e.textContent || '').replace(/\\s+/g, ' ').trim())
  return JSON.stringify({
    productIds: g('[data-test="invite-product-ids"]'),
    batchProductCount: g('[data-test="invite-batch-product-count"]'),
    count: g('[data-test="invite-count"]'),
    fieldLabels: labels
  })
})()`)

console.log('=== 微信小店 ===')
console.log('切页签:', await openPanel(WX))
console.log(JSON.stringify(JSON.parse(await readFields()), null, 1))

console.log('\n=== 快手小店 ===')
console.log('切页签:', await openPanel(KS))
console.log(JSON.stringify(JSON.parse(await readFields()), null, 1))

// ③ 写入验证（改微信的商品ID → 保存 → 读回设置 → 还原）
console.log('\n=== 写入验证（微信小店商品ID）===')
await openPanel(WX)
const key = `invite.config.store.${WX}`
const before = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const beforeIds = before?.ok ? String(before.data?.value?.productIds || '') : ''
const probe = '10000687986563,10000687986564'
await app.ev(`(() => { const el = document.querySelector('[data-test="invite-product-ids"]'); el.value = ${JSON.stringify(probe)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
await sleep(600)
await app.ev(`(() => { const b = document.querySelector('[data-test="invite-save-config"]'); if (b) b.click(); return !!b })()`)
await sleep(2500)
const after = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const afterIds = after?.ok ? String(after.data?.value?.productIds || '') : ''
console.log(`保存前: 「${beforeIds}」 → 保存后: 「${afterIds}」`)
console.log(afterIds === probe ? '✅ 商品ID 已能通过面板写入配置' : '❌ 写入未生效')
// 还原
await app.ev(`(() => { const el = document.querySelector('[data-test="invite-product-ids"]'); el.value = ${JSON.stringify(beforeIds)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
await sleep(500)
await app.ev(`(() => { const b = document.querySelector('[data-test="invite-save-config"]'); if (b) b.click(); return !!b })()`)
await sleep(2000)
const restored = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
console.log('还原后:', String(restored?.ok ? restored.data?.value?.productIds : ''))
app.close()
process.exit(0)
