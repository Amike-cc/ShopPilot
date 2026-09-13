/** 真机验证重构后的邀约面板：卡片结构、一级/二级联动、持久化扩展、保存恢复 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(2500)
  await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('1111'));c.click();return 1})()`)
  await sleep(1200)
  await ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\u4efb\u52a1');tab.click();return 1})()`)
  await sleep(1000)

  // 1) 卡片结构
  const cards = await ev(`(()=>{const p=document.querySelector('[data-test=invite-panel]');return JSON.stringify([...p.querySelectorAll('.inv-card-h')].map(h=>String(h.innerText||'').replace(/\s+/g,' ').trim()))})()`)
  console.log('cards:', cards)

  // 2) 一级/二级联动
  console.log('sub before pick:', await ev(`(()=>{const s=document.querySelector('[data-test=invite-subcategory]');return JSON.stringify({disabled:s.disabled,options:[...s.options].map(o=>o.value)})})()`))
  console.log('pick 一级=个护家清:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-category]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'\u4e2a\u62a4\u5bb6\u6e05');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`))
  await sleep(500)
  console.log('sub after pick:', await ev(`(()=>{const s=document.querySelector('[data-test=invite-subcategory]');return JSON.stringify({disabled:s.disabled,options:[...s.options].map(o=>o.value)})})()`))
  console.log('pick 二级=家清纸品:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-subcategory]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'\u5bb6\u6e05\u7eb8\u54c1');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`))
  // 切回一级=生鲜 → 二级应自动回「不限」
  console.log('switch 一级=生鲜:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-category]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'\u751f\u9c9c');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`))
  await sleep(400)
  console.log('sub after switch:', await ev(`(()=>{const s=document.querySelector('[data-test=invite-subcategory]');return JSON.stringify({value:s.value,options:[...s.options].map(o=>o.value)})})()`))
  // 设回 个护家清/家清纸品 用于保存
  await ev(`(()=>{const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');const c=document.querySelector('[data-test=invite-category]');d.set.call(c,'\u4e2a\u62a4\u5bb6\u6e05');c.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`)
  await sleep(300)
  await ev(`(()=>{const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');const s=document.querySelector('[data-test=invite-subcategory]');d.set.call(s,'\u5bb6\u6e05\u7eb8\u54c1');s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`)
  await sleep(900)
  console.log('stored:', await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.\u6296\u5e97');return JSON.stringify(r.data&&r.data.value)})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
