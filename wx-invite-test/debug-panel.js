/** 分步排查：店铺选中 → 任务页签 → 面板字段读取与设置 */
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
  console.log('open:', await ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return JSON.stringify({ok:r.ok})})()`))
  await sleep(2500)
  console.log('storeCards:', await ev(`JSON.stringify([...document.querySelectorAll('.store-card')].map(e=>String(e.innerText||'').replace(/\\s+/g,' ').slice(0,20)))`))
  console.log('click store:', await ev(`(()=>{const card=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('1111'));if(!card)return 'no-card';card.click();return 'clicked'})()`))
  await sleep(1500)
  console.log('ptabs:', await ev(`JSON.stringify([...document.querySelectorAll('.ptab')].map(e=>String(e.innerText||'').trim()))`))
  console.log('click tab:', await ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\\u4efb\\u52a1');if(!tab)return 'no-tab';tab.click();return 'clicked'})()`))
  await sleep(900)
  console.log('panel fields:', await ev(`(()=>{const q=s=>document.querySelector(s);const cnt=q('[data-test=invite-count]');const cat=q('[data-test=invite-category]');const script=q('[data-test=invite-script]');return JSON.stringify({count:cnt?cnt.value:null,category:cat?cat.value:null,scriptLen:script?script.value.length:null,levels:[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test'))})})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
