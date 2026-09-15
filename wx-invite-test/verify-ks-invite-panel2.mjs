/**
 * 打开快手店铺（走 UI 的真实路径：左栏店铺行的 ▶ 按钮）→ 切到「达人邀约」页签 → 校验面板。
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

console.log('=== 第一步：点快手店铺行的打开按钮 ===')
console.log(await ev(`(() => {
  // 店铺行里有「福气满满」，找它所在行里的 ▶ 按钮（store-action）
  const rows = [...document.querySelectorAll('.store-row, [class*=store-item], [class*=storeRow]')]
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const nameEl = all.find(el => own(el) === '福气满满')
  if (!nameEl) return 'no-store'
  let row = nameEl
  for (let i = 0; i < 6 && row; i++, row = row.parentElement) {
    const btn = row.querySelector ? row.querySelector('.store-action') : null
    if (btn) { btn.click(); return 'clicked store-action in ' + row.className.slice(0, 40) }
  }
  return 'no-action-btn'
})()`))
await sleep(5000)
console.log('displayedStoreId 是否已设:', await ev(`(() => {
  // 用面板判断：欢迎页消失即已选中店铺
  return !document.querySelector('.welcome')
})()`))
console.log('当前可见的 data-test:', await ev(`[...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')).slice(0,25).join(',')`))

console.log('\n=== 第二步：切到「达人邀约」页签 ===')
console.log(await ev(`(() => {
  const b = document.querySelector('[data-test=task-subtab-invite]')
  if (!b) return 'no-subtab'
  b.click(); return 'clicked'
})()`))
await sleep(2000)

console.log('\n=== 第三步：校验面板 ===')
check('① 邀约页签已打开', await ev(`!!document.querySelector('[data-test=invite-panel]')`) === true)
const panelText = String(await ev(`(() => { const p=document.querySelector('[data-test=invite-panel]'); return p ? String(p.innerText||'').replace(/\\s+/g,' ') : '' })()`))
console.log('   面板首 120 字:', panelText.slice(0, 120))
check('② 标题为「达人邀约 · 快手小店」', panelText.includes('达人邀约 · 快手小店'))
const optCount = await ev(`document.querySelector('[data-test=invite-category]')?.options.length`)
check('③ 类目下拉 18 项（+1 个"不筛选"）', optCount === 19, 'options=' + optCount)
check('④ 不显示「达人等级」', !panelText.includes('达人等级'))
check('⑤ 有「内容标签」行', panelText.includes('内容标签'))
check('⑥ 有「合作信息」行', panelText.includes('合作信息'))
check('⑦ 内容标签「美妆」可勾', await ev(`!!document.querySelector('[data-test="invite-extra-内容标签-美妆"]')`) === true)
check('⑧ 合作信息「有联系方式」可勾', await ev(`!!document.querySelector('[data-test="invite-extra-合作信息-有联系方式"]')`) === true)
check('⑨ 联系人输入框', await ev(`!!document.querySelector('[data-test=invite-batch-contact]')`) === true)
check('⑩ 手机号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-phone]')`) === true)
check('⑪ 微信号输入框', await ev(`!!document.querySelector('[data-test=invite-batch-wechat]')`) === true)
check('⑫ 标签叫「合作标签」', panelText.includes('合作标签'))
check('⑬ 不出现抖店的「专属权益」', !panelText.includes('专属权益'))
check('⑭ 有邀约商品数输入', await ev(`!!document.querySelector('[data-test=invite-batch-products]')`) === true)
check('⑮ 提示至少勾 2 位', /至少\s*2\s*位/.test(panelText))
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
check('⑰ 填齐后可开始', d2 === false, 'disabled=' + d2)

// 二级类目联动：选「个护家清」应出现实测子类
await ev(`(() => {
  const sel = document.querySelector('[data-test=invite-category]')
  const d = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value')?.set
  d ? d.call(sel, '个护家清') : (sel.value = '个护家清')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 1
})()`)
await sleep(1200)
const subs = await ev(`[...(document.querySelector('[data-test=invite-subcategory]')?.options || [])].map(o=>o.text)`)
check('⑱ 二级类目联动为实测子类', Array.isArray(subs) && subs.includes('个护仪器') && subs.includes('纸品湿巾'), '子类=' + (subs || []).slice(0, 5).join('/'))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-invite-panel.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-invite-panel.png')
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
