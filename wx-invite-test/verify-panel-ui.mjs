/**
 * 验证微信邀约面板 UI 优化后的交互可用性（不发送）：
 *   ① 配置摘要条显示
 *   ② 类目默认折叠 + 「展开全部」可展开
 *   ③ 类目搜索可过滤
 *   ④ 「清空」已选类目
 *   ⑤ 运行条吸底（滚动后仍可见）
 *   ⑥ 关键 data-test 未被破坏（开始邀约/打开广场/联系人等）
 * 用法：node verify-panel-ui.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

// 确保在面板上
await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.display('${STORE}');return 1})()`)
await sleep(1500)
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes('微信小店测试')); if (c) c.click(); return 1 })()`)
await sleep(3000)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2000)

const panel = '[data-test=invite-panel]'
// 归零面板状态：清掉搜索/已选/展开，保证每次跑的起点一致（否则上一轮的残留会让折叠基线反向）
await ev(`(() => {
  const t = document.querySelector('[data-test=invite-cats-toggle]')
  if (t && /收起/.test(String(t.innerText))) t.click()
  return 1
})()`)
await sleep(400)
await ev(`(() => { const b = document.querySelector('[data-test=invite-cats-clear]'); if (b) b.click(); return 1 })()`)
await sleep(500)
const baseline = await ev(`document.querySelectorAll('[data-test^=invite-finder-category-]').length`)
console.log('基线（清空+未展开）类目控件数:', baseline)

// ① 摘要条
const sum = await ev(`(() => { const el = document.querySelector('[data-test=invite-summary]'); return el ? String(el.innerText||'').replace(/\\s+/g,' ').trim() : null })()`)
console.log('摘要条:', sum)
check('① 配置摘要条已显示', !!sum && sum.includes('类型'), sum || '')
check('① 摘要含联系人/商品', !!sum && /联系人/.test(sum) && /商品/.test(sum))

// ② 类目折叠/展开
const before = baseline
const toggleExists = await ev(`!!document.querySelector('[data-test=invite-cats-toggle]')`)
check('② 默认折叠（类目控件数 < 34）', before < 34, `当前 ${before} 个`)
check('② 有「展开全部」按钮', toggleExists === true)
console.log('点击展开…')
await ev(`document.querySelector('[data-test=invite-cats-toggle]').click()`)
await sleep(800)
const expanded = await ev(`document.querySelectorAll('[data-test^=invite-finder-category-]').length`)
check('② 展开后显示全部 34 项', expanded === 34, `展开后 ${expanded} 个`)
// 收起
await ev(`(() => { const b = document.querySelector('[data-test=invite-cats-toggle]'); if (b && /收起/.test(String(b.innerText))) b.click(); return 1 })()`)
await sleep(600)

// ③ 搜索
console.log('测试搜索「生鲜」…')
await ev(`(() => { const b = document.querySelector('[data-test=invite-cats-toggle]'); if (b && /展开/.test(String(b.innerText))) b.click(); return 1 })()`)
await sleep(700)
const searchExists = await ev(`!!document.querySelector('[data-test=invite-cat-search]')`)
check('③ 展开后有搜索框', searchExists === true)
if (searchExists) {
  await ev(`(() => {
    const el = document.querySelector('[data-test=invite-cat-search]')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '生鲜')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(700)
  const filtered = JSON.parse(await ev(`(() => {
    const els = [...document.querySelectorAll('[data-test^=invite-finder-category-]')]
    return JSON.stringify({ n: els.length, names: els.map(e => e.value) })
  })()`))
  check('③ 搜索过滤生效', filtered.n > 0 && filtered.n < 34 && filtered.names.every(n => n.includes('生鲜')), `剩 ${filtered.n} 项: ${filtered.names.join('/')}`)
  // 清空搜索
  await ev(`(() => {
    const el = document.querySelector('[data-test=invite-cat-search]')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(600)
}

// ④ 清空已选
const pickedBefore = await ev(`document.querySelectorAll('[data-test^=invite-finder-category-]:checked').length`)
console.log('已选类目数:', pickedBefore)
if (pickedBefore > 0) {
  await ev(`document.querySelector('[data-test=invite-cats-clear]').click()`)
  await sleep(700)
  const after = await ev(`document.querySelectorAll('[data-test^=invite-finder-category-]:checked').length`)
  check('④「清空」清掉了已选类目', after === 0, `剩 ${after} 个`)
} else {
  console.log('（当前无已选类目，跳过清空验证）')
}

// ⑤ 运行条吸底
const sticky = JSON.parse(await ev(`(() => {
  const bar = document.querySelector('[data-test=invite-run-bar]')
  if (!bar) return JSON.stringify({ ok: false })
  const cs = getComputedStyle(bar)
  return JSON.stringify({ position: cs.position, bottom: cs.bottom, ok: cs.position === 'sticky' })
})()`))
check('⑤ 运行条使用 sticky 吸底', sticky.ok === true, JSON.stringify(sticky))
// 滚到底再看是否仍在可视区
await ev(`(() => {
  const body = document.querySelector('[data-test=invite-panel]').closest('.panel-body')
  if (body) body.scrollTop = body.scrollHeight
  return 1
})()`)
await sleep(900)
const visible = JSON.parse(await ev(`(() => {
  const bar = document.querySelector('[data-test=invite-run-bar]')
  const btn = document.querySelector('[data-test=invite-start]')
  const b = bar && bar.getBoundingClientRect()
  const bb = btn && btn.getBoundingClientRect()
  const host = bar && bar.closest('.panel-body')
  const hb = host && host.getBoundingClientRect()
  return JSON.stringify({
    在可视区: !!(b && hb && b.top < hb.bottom && b.bottom > hb.top),
    按钮在可视区: !!(bb && hb && bb.top < hb.bottom && bb.bottom > hb.top),
    barTop: b ? Math.round(b.top) : null, hostBottom: hb ? Math.round(hb.bottom) : null
  })
})()`))
check('⑤ 滚动到底后运行条/按钮仍可见', visible.在可视区 && visible.按钮在可视区, JSON.stringify(visible))

// ⑥ 关键 data-test 完好
const hooks = JSON.parse(await ev(`(() => {
  const need = ['invite-open-page','invite-finder-type','invite-contact','invite-wechat','invite-phone','invite-script','invite-product-ids','invite-product-count','invite-start','invite-script-mode-manual','invite-script-mode-ai','invite-panel']
  const miss = need.filter(t => !document.querySelector('[data-test=' + t + ']'))
  return JSON.stringify({ 缺失: miss, 总数: need.length })
})()`))
check('⑥ 关键控件 data-test 全部保留', hooks.缺失.length === 0, JSON.stringify(hooks))
// 必填门禁仍生效（清空联系人 → 按钮禁用）
await ev(`(() => {
  const el = document.querySelector('[data-test=invite-contact]')
  window.__savedContact = el.value
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 1
})()`)
await sleep(600)
const dis = await ev(`document.querySelector('[data-test=invite-start]').disabled`)
check('⑥ 必填门禁仍生效（清空联系人→禁用）', dis === true)
await ev(`(() => {
  const el = document.querySelector('[data-test=invite-contact]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, window.__savedContact || '刘涛')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 1
})()`)
await sleep(700)
const en = await ev(`document.querySelector('[data-test=invite-start]').disabled`)
check('⑥ 填回后按钮恢复可用', en === false)

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
// 回到顶部
await ev(`(() => { const body = document.querySelector('[data-test=invite-panel]').closest('.panel-body'); if (body) body.scrollTop = 0; return 1 })()`)
ws.close()
setTimeout(() => process.exit(0), 300)
