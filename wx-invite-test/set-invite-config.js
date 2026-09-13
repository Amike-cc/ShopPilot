/** 真实 UI 全流程验证配置保存：打开面板 → 真实点击/输入特征配置 → 轮询存档 → 打印面板状态 */
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

  console.log('open store:', await ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(2500)
  console.log('select store:', await ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('1111'));c.click();return 'ok'})()`))
  await sleep(1200)
  console.log('open tasks tab:', await ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\u4efb\u52a1');tab.click();return 'ok'})()`))
  await sleep(900)

  // 特征配置：类目=食品饮料，等级=LV2+LV4，数量=33，话术=特征串
  console.log('set category:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-category]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'\u98df\u54c1\u996e\u6599');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`))
  await sleep(300)
  // 等级：逐个稳定到目标集合 {LV2, LV4}
  for (let round = 0; round < 8; round++) {
    const st = await ev(`(()=>{const want=new Set(['invite-level-LV2','invite-level-LV4']);const cur=[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test'));const toOff=cur.find(x=>!want.has(x));const toOn=[...want].find(x=>!cur.includes(x));const el=toOff?document.querySelector('[data-test='+toOff+']'):document.querySelector('[data-test='+toOn+']');if(!el)return JSON.stringify({done:true,cur});el.click();return JSON.stringify({clicked:toOff||toOn,cur})})()`)
    const parsed = JSON.parse(st)
    if (parsed.done) { console.log('levels settled:', parsed.cur); break }
    await sleep(350)
  }
  console.log('set count:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-count]');const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,'33');el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()`))
  console.log('set script:', await ev(`(()=>{const el=document.querySelector('[data-test=invite-script]');const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');d.set.call(el,'\u4fdd\u5b58\u914d\u7f6e\u9a8c\u8bc1\u8bdd\u672fXYZ123');el.dispatchEvent(new Event('input',{bubbles:true}));return el.value.length})()`))

  // 轮询存档（防抖 500ms）
  let saved = null
  for (let i = 0; i < 10; i++) {
    await sleep(700)
    saved = await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.\\u6296\\u5e97');return JSON.stringify(r.data&&r.data.value)})()`)
    console.log('poll', (i + 1) * 0.7 + 's:', saved)
    if (saved && saved !== 'null') break
  }
  console.log('panel final:', await ev(`(()=>{const q=s=>document.querySelector(s);return JSON.stringify({
    category:q('[data-test=invite-category]').value,
    levels:[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test')),
    count:q('[data-test=invite-count]').value,
    script:q('[data-test=invite-script]').value
  })})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
