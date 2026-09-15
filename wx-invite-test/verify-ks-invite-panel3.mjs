/**
 * 真机验证「达人邀约 · 快手小店」面板（按已验证可用的打开路径：
 * browser.open/display → 点左栏店铺卡 → 点「任务」页签 → 点「达人邀约」子页签）。
 * 只读（不点「开始邀约」）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
if (!ks) { console.log('没有快手店铺'); process.exit(1) }
console.log('快手店铺:', ks.name, ks.id)

await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2000)
// 点左栏店铺卡（真正的"选中店铺"动作）
console.log('点店铺卡:', await ev(`(() => {
  const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(${JSON.stringify(ks.name)}))
  if (!c) return 'no-card'
  c.click(); return 'clicked'
})()`))
await sleep(3500)
// 打开「任务」页签
console.log('点任务页签:', await ev(`(() => { const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务'); if(t){t.click();return 'clicked'} return 'no-tab' })()`))
await sleep(2000)
// 打开「达人邀约」子页签
console.log('点达人选约子页签:', await ev(`(() => {
  const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'))
  if(t){t.click();return 'clicked'} return 'no-subtab'
})()`))
await sleep(2500)

console.log('\n=== 校验面板 ===')
check('① 邀约面板已打开', await ev(`!!document.querySelector('[data-test=invite-panel]')`) === true)
const panelText = String(await ev(`(() => { const p=document.querySelector('[data-test=invite-panel]'); return p ? String(p.innerText||'').replace(/\\s+/g,' ') : '' })()`))
console.log('   面板首 140 字:', panelText.slice(0, 140))
check('② 标题为「达人邀约 · 快手小店」', panelText.includes('达人邀约 · 快手小店'))
const optCount = await ev(`document.querySelector('[data-test=invite-category]')?.options.length`)
check('③ 类目下拉 19 项（18 类目 + 不筛选）', optCount === 19, 'options=' + optCount)
check('④ 不显示「达人等级」（快手无该维度）', !panelText.includes('达人等级'))
check('⑤ 有「内容标签」筛选行', panelText.includes('内容标签'))
check('⑥ 有「合作信息」筛选行', panelText.includes('合作信息'))
check('⑦ 内容标签「美妆」可勾选', await ev(`!!document.querySelector('[data-test="invite-extra-内容标签-美妆"]')`) === true)
check('⑧ 合作信息「有联系方式」可勾选', await ev(`!!document.querySelector('[data-test="invite-extra-合作信息-有联系方式"]')`) === true)
check('⑨ 联系人输入框', await ev(`!!document.querySelector('[data-test=invite-batch-contact]')`) === true)
check('⑩ 手机号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-phone]')`) === true)
check('⑪ 微信号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-wechat]')`) === true)
check('⑫ 标签叫「合作标签」', panelText.includes('合作标签'))
check('⑬ 不出现抖店的「专属权益」', !panelText.includes('专属权益'))
check('⑭ 有邀约商品数输入', await ev(`!!document.querySelector('[data-test=invite-batch-products]')`) === true)
check('⑮ 提示平台至少勾 2 位', /至少\s*2\s*位/.test(panelText))
const d1 = await ev(`document.querySelector('[data-test=invite-start]')?.disabled`)
check('⑯ 必填项未填时「开始邀约」禁用', d1 === true, 'disabled=' + d1)

await ev(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set; d ? d.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
  set('[data-test=invite-batch-contact]', '刘涛')
  set('[data-test=invite-batch-phone]', '13148070563')
  set('[data-test=invite-batch-wechat]', 'amike688')
  set('[data-test=invite-script]', '您好，想邀请您合作带货，给专属高佣与免费寄样，素材与发货售后我们全包。')
  return 1
})()`)
await sleep(2500)
const d2 = await ev(`document.querySelector('[data-test=invite-start]')?.disabled`)
check('⑰ 填齐联系方式+话术后可开始', d2 === false, 'disabled=' + d2)

// 二级类目联动（实测子类）
await ev(`(() => {
  const sel = document.querySelector('[data-test=invite-category]')
  const d = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value')?.set
  d ? d.call(sel, '个护家清') : (sel.value = '个护家清')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 1
})()`)
await sleep(1500)
const subs = await ev(`[...(document.querySelector('[data-test=invite-subcategory]')?.options || [])].map(o=>o.text)`)
check('⑱ 二级类目联动为实测子类', Array.isArray(subs) && subs.includes('个护仪器') && subs.includes('纸品湿巾'), '子类前 6 项=' + (subs || []).slice(0, 6).join('/'))

// 额外筛选可勾选并保持（勾上后 checked 应为真）
await ev(`document.querySelector('[data-test="invite-extra-内容标签-美妆"]')?.click()`)
await sleep(900)
check('⑲ 内容标签勾选生效', await ev(`document.querySelector('[data-test="invite-extra-内容标签-美妆"]')?.checked`) === true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-invite-panel.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-invite-panel.png')
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
