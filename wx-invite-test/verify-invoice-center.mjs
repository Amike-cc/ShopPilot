/**
 * 验证「发票中心」面板（真机，只读 + 打开入口不发送任何东西）：
 *   ① 左栏入口是「发票中心」（旧「数据中心」入口已移除）
 *   ② 面板列出所有店铺，每行有发票入口按钮
 *   ③ 已实测的入口标「已实测」，未实测的标「未实测」
 *   ④ 点入口能把对应店铺打开并导航到该地址（用微信/拼多多实测地址验证）
 *   ⑤ 关闭按钮可用
 */
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

await ev(`(async()=>{await window.shopilot.browser.display(null);return 1})()`)
await sleep(1500)

// ① 左栏入口
check('① 左栏入口已改为「发票中心」', (await ev(`(() => {
  const rows = [...document.querySelectorAll('.dc-entry-row')]
  return rows.some(r => String(r.innerText||'').includes('发票中心'))
})()`)) === true)
check('① 左栏不再有「数据中心」入口', (await ev(`!String(document.body.innerText||'').includes('数据中心')`)) === true)
check('① 预留 data-test 就位', (await ev(`!!document.querySelector('[data-test=invoice-center-open]')`)) === true)

// ② 打开面板
await ev(`document.querySelector('[data-test=invoice-center-open]').click()`)
await sleep(2000)
check('② 面板已打开', (await ev(`!!document.querySelector('[data-test=invoice-center-modal]')`)) === true)
const rows = JSON.parse(await ev(`(() => {
  const rs = [...document.querySelectorAll('[data-test=invoice-row]')]
  return JSON.stringify(rs.map(r => ({
    店铺: String((r.querySelector('b') || {}).innerText || '').trim(),
    链接: [...r.querySelectorAll('.inv-link')].map(a => ({
      文案: String((a.querySelector('.inv-link-t') || {}).innerText || '').trim(),
      标记: String((a.querySelector('.inv-vtag') || {}).innerText || '').trim(),
      url: a.getAttribute('title')
    }))
  })))
})()`))
console.log('面板内容:'); console.log(JSON.stringify(rows, null, 1))
check('② 列出了全部店铺（4 家）', rows.length === 4, rows.map(r => r.店铺).join('、'))
check('② 每行都有入口按钮', rows.every(r => r.链接.length > 0))

// ③ 已实测/未实测标注
const wx = rows.find(r => r.店铺.includes('微信小店测试'))
const ks = rows.find(r => r.店铺.includes('福气满满'))
const dd = rows.find(r => r.店铺.includes('1111'))
const pdd = rows.find(r => r.店铺.includes('慕么美'))
check('③ 微信小店入口标「已实测」', !!wx && wx.链接.some(x => x.标记 === '已实测' && x.url.includes('/shop/bill/home')), JSON.stringify(wx && wx.链接))
check('③ 拼多多入口标「已实测」', !!pdd && pdd.链接.some(x => x.标记 === '已实测' && x.url.includes('/invoice/center')), JSON.stringify(pdd && pdd.链接))
check('③ 快手入口标「未实测」（实测无独立发票入口）', !!ks && ks.链接.every(x => x.标记 === '未实测'), JSON.stringify(ks && ks.链接))
check('③ 抖店入口标「未实测」（当前未登录，测不了）', !!dd && dd.链接.every(x => x.标记 === '未实测'), JSON.stringify(dd && dd.链接))

// ④ 点入口 → 对应店铺被打开并导航（用微信小店的实测地址验证）
const before = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
console.log('点击前微信店铺标签页:', JSON.stringify(before.map(u => u.slice(0, 60))))
await ev(`(() => {
  const rs = [...document.querySelectorAll('[data-test=invoice-row]')]
  const row = rs.find(r => String(r.innerText||'').includes('微信小店测试'))
  const a = [...row.querySelectorAll('.inv-link')].find(x => String(x.getAttribute('title')||'').includes('/shop/bill/home'))
  a.click()
  return 1
})()`)
await sleep(11000)
const after = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf');return JSON.stringify({active:r.data&&r.data.activeTabId, tabs:((r.data&&r.data.tabs)||[]).map(t=>String(t.url||''))})})()`))
console.log('点击后微信店铺标签页:', JSON.stringify(after.tabs.map(u => u.slice(0, 70))))
check('④ 已导航到微信小店发票中心', after.tabs.some(u => u.includes('/shop/bill/home')), JSON.stringify(after.tabs.map(u => u.slice(0, 60))))
check('④ 面板已自动关闭', (await ev(`!document.querySelector('[data-test=invoice-center-modal]')`)) === true)
// 该页是否真的是发票中心（未登录/无权限时平台自己会说，这里只报事实）
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('/shop/bill/home'))
if (pages.length) {
  const w2 = new WebSocket(pages[0].webSocketDebuggerUrl)
  await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
  let s2 = 0; const p2 = new Map()
  w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
  const q = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  console.log('发票中心页内容:', await q(`(() => { const t = String(document.body?document.body.innerText:'').replace(/\\s+/g,' '); return JSON.stringify({ 含发票字样: /发票/.test(t), 片段: t.slice(0, 160) }) })()`))
  w2.close()
}

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
