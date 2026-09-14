/**
 * 验证「添加商品数量」已从微信邀约面板移除（不发送）：
 *   ① 面板上不再有 invite-product-count 控件
 *   ② 商品ID 输入仍在，提示文案已更新
 *   ③ 摘要条商品项显示「N 个ID」或「1 个(自动)」
 *   ④ 必填门禁：产品数量不再是必填条件 → 联系人/微信/手机/话术齐备即可开始
 *   ⑤ 抖店面板的「本批数量」不受影响（那是另一个字段 invite-count）
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

check('① 微信面板已无「添加商品数量」控件', (await ev(`!document.querySelector('[data-test=invite-product-count]')`)) === true)
check('① 面板文案里也没有「添加商品数量」', (await ev(`!String(document.querySelector('[data-test=invite-panel]').innerText||'').includes('添加商品数量')`)) === true)
check('② 商品ID 输入仍在', (await ev(`!!document.querySelector('[data-test=invite-product-ids]')`)) === true)
const hint = await ev(`(() => { const t = document.querySelector('[data-test=invite-product-ids]'); const p = t && t.parentElement; const sub = p && p.querySelector('.row-sub'); return sub ? String(sub.innerText||'').trim() : '' })()`)
console.log('商品提示:', hint)
check('② 提示文案已更新（按ID指定/留空自动加1个）', /按 ID 精确指定/.test(hint) && /留空则自动添加 1 个/.test(hint), hint)
const sum = await ev(`(() => { const el = document.querySelector('[data-test=invite-summary]'); return el ? String(el.innerText||'').replace(/\\s+/g,' ').trim() : '' })()`)
console.log('摘要:', sum)
check('③ 摘要商品项合理（个ID 或 1 个(自动)）', /个ID|1 个\(自动\)/.test(sum), sum)

// ④ 必填门禁：四个字段齐备 → 可用；缺联系人 → 禁用（商品数量不再是条件）
const btnState = () => ev(`document.querySelector('[data-test=invite-start]').disabled`)
const setVal = async (tid, v) => ev(`(() => { const el = document.querySelector('[data-test=${tid}]'); if (!el) return 1; Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
const saved = JSON.parse(await ev(`JSON.stringify({ c: document.querySelector('[data-test=invite-contact]').value })`))
check('④ 四字段齐备时可开始（商品数量不再是必填）', (await btnState()) === false)
await setVal('invite-contact', '')
await sleep(500)
check('④ 清空联系人 → 仍按原规则禁用', (await btnState()) === true)
await setVal('invite-contact', saved.c)
await sleep(600)
check('④ 填回后恢复可用', (await btnState()) === false)

// ⑤ 抖店「本批数量」不受影响
await ev(`(async()=>{const DD='store_3b4c2823d4d9cf6d0bdea96882ce38cc';await window.shopilot.browser.open(DD);await window.shopilot.browser.display(DD);return 1})()`)
await sleep(3000)
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes('1111')); if (c) c.click(); return 1 })()`)
await sleep(3000)
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)
check('⑤ 抖店「本批数量」仍在（invite-count）', (await ev(`!!document.querySelector('[data-test=invite-count]')`)) === true)
check('⑤ 抖店面板不含微信的商品ID控件', (await ev(`!document.querySelector('[data-test=invite-product-ids]')`)) === true)

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
