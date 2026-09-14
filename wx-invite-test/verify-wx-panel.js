/** 真机验证微信面板：筛选卡片 + 商品ID字段 + 配置持久化 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const WX_STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
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

  // 打开微信店铺窗口并选中「微信小店测试」
  console.log('open store:', await ev(`(async()=>{const r=await window.shopilot.browser.open('${WX_STORE}');return r.ok})()`))
  await sleep(3000)
  const picked = await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(!c)return 'no-card';c.click();return 'clicked'})()`)
  console.log('store picked:', picked)
  await sleep(1500)
  await ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(tab)tab.click();return 1})()`)
  await sleep(1200)

  // 面板结构
  console.log('cards:', await ev(`(()=>{const p=document.querySelector('[data-test=invite-panel]');if(!p)return 'no-panel';return JSON.stringify([...p.querySelectorAll('.inv-card-h')].map(h=>String(h.innerText||'').replace(/\\s+/g,' ').trim()))})()`))
  console.log('finder type options:', await ev(`(()=>{const s=document.querySelector('[data-test=invite-finder-type]');if(!s)return 'no-select';return JSON.stringify([...s.options].map(o=>o.value))})()`))
  console.log('category chips:', await ev(`(()=>{const c=[...document.querySelectorAll('[data-test^=invite-finder-category-]')];return JSON.stringify({count:c.length,first:c.slice(0,4).map(x=>x.getAttribute('data-test'))})})()`))
  console.log('other chips:', await ev(`(()=>{const c=[...document.querySelectorAll('[data-test^=invite-finder-other-]')];return JSON.stringify(c.map(x=>x.getAttribute('data-test')))})()`))
  console.log('productIds field:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-product-ids]');return el?JSON.stringify({tag:el.tagName,ph:el.getAttribute('placeholder')}):'missing'})()`))

  // 设置筛选 + 商品ID，等持久化
  const setChip = async (dt) => ev(`(()=>{const el=document.querySelector('[data-test="${dt}"]');if(!el)return 'missing';if(!el.checked)el.click();return String(el.checked)})()`)
  console.log('pick 直播带货者:', await ev(`(()=>{const s=document.querySelector('[data-test=invite-finder-type]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(s,'直播带货者');s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`))
  console.log('pick cat 母婴:', await setChip('invite-finder-category-母婴'))
  console.log('pick other 有联系方式:', await setChip('invite-finder-other-有联系方式'))
  console.log('set productIds:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-product-ids]');const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');d.set.call(el,'10000687986563, 10000687986564');el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()`))
  await sleep(1200)
  console.log('stored:', await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.微信小店');const v=r.data&&r.data.value;return JSON.stringify({finderType:v.finderType,categories:v.finderCategories,others:v.finderOtherFilters,productIds:v.productIds,contact:v.contact})})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
