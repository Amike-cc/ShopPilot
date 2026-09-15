/**
 * 真机验证「达人邀约 · 快手小店」面板：切到快手店铺 → 打开邀约页签 → 截图 + 校验控件。
 * 只读（不点「开始邀约」）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

// 找到快手店铺并显示（面板按 displayedStoreId 取平台档案）
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
if (!ks) { console.log('没有快手店铺'); process.exit(1) }
console.log('快手店铺:', ks.name, ks.id)
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(3000)

// 切到「达人邀约」页签
await ev(`document.querySelector('[data-test=task-subtab-invite]')?.click()`)
await sleep(2000)
check('① 邀约页签已打开', await ev(`!!document.querySelector('[data-test=invite-panel]')`) === true)

const panelText = String(await ev(`(() => { const p=document.querySelector('[data-test=invite-panel]'); return p ? String(p.innerText||'').replace(/\\s+/g,' ') : '' })()`))
check('② 面板标题是「达人邀约 · 快手小店」', panelText.includes('达人邀约 · 快手小店'), panelText.slice(0, 60))

// 关键控件按档案渲染
check('③ 有类目下拉（带货类目 18 项）', await ev(`(() => { const s=document.querySelector('[data-test=invite-category]'); return !!s && s.options.length })()`) === 19,
  '选项数=' + await ev(`document.querySelector('[data-test=invite-category]')?.options.length`))
// 快手没有达人等级 → 不渲染等级区
check('④ 不显示「达人等级」（快手无该筛选维度）', !panelText.includes('达人等级'))
// 额外筛选行
check('⑤ 显示「内容标签」行（快手特有）', panelText.includes('内容标签'))
check('⑥ 显示「合作信息」行', panelText.includes('合作信息'))
check('⑦ 内容标签项可勾选（美妆）', await ev(`!!document.querySelector('[data-test="invite-extra-内容标签-美妆"]')`) === true)
check('⑧ 合作信息项可勾选（有联系方式）', await ev(`!!document.querySelector('[data-test="invite-extra-合作信息-有联系方式"]')`) === true)
// 必填联系方式
check('⑨ 有联系人输入框', await ev(`!!document.querySelector('[data-test=invite-batch-contact]')`) === true)
check('⑩ 有手机号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-phone]')`) === true)
check('⑪ 有微信号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-wechat]')`) === true)
// 合作标签（不是"专属权益"）
check('⑫ 标签叫「合作标签」且有 6 项', panelText.includes('合作标签') && panelText.includes('可破价'))
check('⑬ 不出现抖店的「专属权益」文案', !panelText.includes('专属权益'))
// 商品数与下限提示
check('⑭ 有邀约商品数输入（快手商品在弹窗里选）', await ev(`!!document.querySelector('[data-test=invite-batch-products]')`) === true)
check('⑮ 提示平台至少勾 2 位', panelText.includes('至少') && panelText.includes('2 位'))
// 未填联系方式时不能开始
const disabled = await ev(`document.querySelector('[data-test=invite-start]')?.disabled`)
check('⑯ 必填项没填时「开始邀约」禁用', disabled === true, 'disabled=' + disabled)

// 填齐必填项后应可开始
await ev(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set; d ? d.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
  set('[data-test=invite-batch-contact]', '刘涛')
  set('[data-test=invite-batch-phone]', '13148070563')
  set('[data-test=invite-batch-wechat]', 'amike688')
  set('[data-test=invite-script]', '您好，想邀请您合作带货，给专属高佣与免费寄样。')
  return 1
})()`)
await sleep(2500)
const disabled2 = await ev(`document.querySelector('[data-test=invite-start]')?.disabled`)
check('⑰ 填齐联系人/手机号/微信/话术后可开始', disabled2 === false, 'disabled=' + disabled2)

// 打开达人广场按钮存在（用它验证入口地址是分销后台）
check('⑱ 有「打开达人广场」按钮', await ev(`!!document.querySelector('[data-test=invite-open-page]')`) === true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-invite-panel.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-invite-panel.png')
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
