/**
 * 微信小店达人邀约 · 面板功能点自动巡检（①面板UI ③配置持久化 ④打开广场按钮 ⑦反例门禁）
 * 只驱动内置浏览器面板，不发送任何邀约。
 * 用法：node wx-panel-inspect.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const P = (label, v) => console.log(`  ${label}: ${v}`)
let pass = 0, fail = 0
const check = (label, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

// ---------- 打开店铺 + 进入「任务 → 达人邀约」 ----------
console.log('=== 进入面板 ===')
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
const storeClick = await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(!c)return 'no-card';c.click();return 'ok'})()`)
P('选中微信店铺', storeClick)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
const subTabs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].map(e=>String(e.innerText||'').trim()))`))
P('子页签', JSON.stringify(subTabs))
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2000)

// ---------- ① 面板 UI 完整性 ----------
console.log('\n=== ① 面板 UI 完整性 ===')
const ui = JSON.parse(await ev(`(() => {
  const q = s => document.querySelectorAll(s).length
  const has = s => !!document.querySelector(s)
  const vis = s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  // 四张卡片：按标题文案找
  const all = [...document.querySelectorAll('[data-test=invite-panel] *')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const heads = [...new Set(all.map(own).filter(t => /^[①②③④]/.test(t)))]
  return JSON.stringify({
    panel: vis('[data-test=invite-panel]'),
    heads,
    openPageBtn: vis('[data-test=invite-open-page]'),
    finderTypeSel: has('[data-test=invite-finder-type]'),
    finderTypeOptions: (document.querySelector('[data-test=invite-finder-type]') || {}).options ? [...document.querySelector('[data-test=invite-finder-type]').options].map(o => o.value) : [],
    catCount: q('[data-test^=invite-finder-category-]'),
    otherCount: q('[data-test^=invite-finder-other-]'),
    contact: vis('[data-test=invite-contact]'),
    wechat: vis('[data-test=invite-wechat]'),
    phone: vis('[data-test=invite-phone]'),
    script: vis('[data-test=invite-script]'),
    productIds: vis('[data-test=invite-product-ids]'),
    productCount: vis('[data-test=invite-product-count]'),
    startBtn: vis('[data-test=invite-start]'),
    startDisabled: (document.querySelector('[data-test=invite-start]')||{}).disabled,
    historyCards: q('[data-test=invite-history-card]'),
    // 抖店专属控件不应出现（当前店铺是微信）
    douyinBits: { category: has('[data-test=invite-category]'), count: has('[data-test=invite-count]'), levels: q('[data-test^=invite-level-]') }
  })
})()`))
check('邀约面板可见', ui.panel)
check('四张卡片齐全', ui.heads.length === 4, JSON.stringify(ui.heads))
check('「打开达人广场」按钮存在', ui.openPageBtn)
check('带货者类型下拉存在且 4 项', ui.finderTypeOptions.length === 4, JSON.stringify(ui.finderTypeOptions))
check('带货类目多选存在', ui.catCount > 0, ui.catCount + ' 项')
check('其他筛选多选存在', ui.otherCount > 0, ui.otherCount + ' 项')
check('联系人/微信号/手机号输入框齐全', ui.contact && ui.wechat && ui.phone)
check('话术输入框存在', ui.script)
check('商品ID 输入 + 数量输入存在', ui.productIds && ui.productCount)
check('「开始邀约」按钮存在', ui.startBtn)
check('微信店铺不显示抖店专属控件（类目下拉/等级/数量）', !ui.douyinBits.category && !ui.douyinBits.count && ui.douyinBits.levels === 0, JSON.stringify(ui.douyinBits))
P('历史邀约卡片数', ui.historyCards)

// ---------- ⑦ 反例：必填门禁 ----------
console.log('\n=== ⑦ 反例：必填校验（按钮禁用态） ===')
const setVal = async (testid, val) => ev(`(() => {
  const el = document.querySelector('[data-test=${testid}]')
  if (!el) return 'no-el'
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)
const btnState = () => ev(`(() => { const b = document.querySelector('[data-test=invite-start]'); return b ? String(!!b.disabled) : 'no-btn' })()`)

// 记录原值以便恢复
const saved = JSON.parse(await ev(`(() => JSON.stringify({
  contact: document.querySelector('[data-test=invite-contact]').value,
  wechat: document.querySelector('[data-test=invite-wechat]').value,
  phone: document.querySelector('[data-test=invite-phone]').value,
  ids: document.querySelector('[data-test=invite-product-ids]').value,
  script: document.querySelector('[data-test=invite-script]').value
}))()`))
P('当前面板值', JSON.stringify(saved))

await setVal('invite-contact', '')
await sleep(400)
check('清空联系人 → 按钮禁用', (await btnState()) === 'true')
await setVal('invite-contact', saved.contact)
await setVal('invite-wechat', '')
await sleep(400)
check('清空微信号 → 按钮禁用', (await btnState()) === 'true')
await setVal('invite-wechat', saved.wechat)
await setVal('invite-phone', '')
await sleep(400)
check('清空手机号 → 按钮禁用', (await btnState()) === 'true')
await setVal('invite-phone', saved.phone)
await setVal('invite-script', '')
await sleep(400)
check('清空话术 → 按钮禁用', (await btnState()) === 'true')
await setVal('invite-script', saved.script)
await sleep(500)
check('全部填回 → 按钮可用', (await btnState()) === 'false')

// ---------- ③ 配置持久化 ----------
console.log('\n=== ③ 配置持久化 ===')
const before = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.微信小店');const v=r&&r.data&&r.data.value;const o=typeof v==='string'?JSON.parse(v):(v||{});return JSON.stringify({contact:o.contact,wechat:o.wechat,phone:o.phone,cats:o.finderCategories,type:o.finderType,other:o.finderOtherFilters})})()`))
P('改动前已保存配置', JSON.stringify(before))
// 改类型 + 类目 → 等防抖落库 → 读回
await ev(`(() => {
  const sel = document.querySelector('[data-test=invite-finder-type]')
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, '短视频带货者')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return sel.value
})()`)
await sleep(2500)
const after = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.微信小店');const v=r&&r.data&&r.data.value;const o=typeof v==='string'?JSON.parse(v):(v||{});return JSON.stringify({type:o.finderType,cats:o.finderCategories,other:o.finderOtherFilters})})()`))
P('改动后落库', JSON.stringify(after))
check('切换带货者类型已持久化', after.type === '短视频带货者', after.type)
// 切回原值
await ev(`(() => {
  const sel = document.querySelector('[data-test=invite-finder-type]')
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(before.type || '直播带货者')})
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return sel.value
})()`)
await sleep(2500)
const restored = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.微信小店');const v=r&&r.data&&r.data.value;const o=typeof v==='string'?JSON.parse(v):(v||{});return JSON.stringify({type:o.finderType})})()`))
check('切回原类型也已持久化', restored.type === (before.type || '直播带货者'), restored.type)

// ---------- ④「打开达人广场」按钮 ----------
console.log('\n=== ④「打开达人广场」按钮（真实调用 prepareInviteSquare） ===')
const beforeTabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
console.log('  点击前标签页数:', beforeTabs.length)
await ev(`(async()=>{document.querySelector('[data-test=invite-open-page]').click();return 1})()`)
await sleep(12000)
const openRes = JSON.parse(await ev(`(() => {
  const t = [...document.querySelectorAll('.toast, [class*=toast], [class*=notice]')].map(e => String(e.innerText || '').trim()).filter(Boolean)
  return JSON.stringify({ toasts: t.slice(-3) })
})()`))
P('提示', JSON.stringify(openRes.toasts))
const afterTabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
console.log('  点击后标签页:', JSON.stringify(afterTabs.map(u => u.slice(0, 70))))

// 直接在广场页读取筛选是否真的应用（面板保存的类型/类目/其他）
await sleep(2000)
const sq = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (sq) {
  const w2 = new WebSocket(sq.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0
  const pend2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend2.has(m.id)) { pend2.get(m.id)(m); pend2.delete(m.id) } }
  const snd = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s2; pend2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: p2 })) })
  const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  const state = await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const sel = all.filter(el => {
      const t = own(el)
      if (!t || t.length > 30) return false
      const p = el.parentElement
      const cls = String((p && p.className) || '') + ' ' + String(el.className || '')
      return /(current|active|checked|selected|on)/i.test(cls)
    }).map(own).filter(Boolean)
    return JSON.stringify({
      expired: /登录超时|请重新登录/.test(txt),
      已筛选: (txt.match(/已筛选[^]{0,80}/) || [])[0] || null,
      选中态文本: [...new Set(sel)].slice(0, 14),
      详情数: all.filter(el => own(el) === '详情').length
    })
  })()`)
  P('广场页状态', state)
  check('登录态有效（未提示登录超时）', !JSON.parse(state).expired)
  check('页面上出现「已筛选」标签（证明筛选真的应用了）', !!JSON.parse(state).已筛选, JSON.parse(state).已筛选 || '无')
  w2.close()
} else {
  check('广场页已打开', false, '没找到 findersquare/find 标签页')
}

console.log(`\n=== 小计：通过 ${pass} / 失败 ${fail} ===`)
ws.close()
process.exit(0)
