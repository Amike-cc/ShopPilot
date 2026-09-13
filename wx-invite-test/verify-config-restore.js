/** 重启后验证：打开面板，字段应恢复为保存的配置（食品饮料 / LV2+LV4 / 33 / 特征话术） */
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
  await sleep(1200)   // 给异步加载+合并留时间
  const panel = await ev(`(()=>{const q=s=>document.querySelector(s);return JSON.stringify({
    category:q('[data-test=invite-category]').value,
    levels:[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test')),
    count:q('[data-test=invite-count]').value,
    script:q('[data-test=invite-script]').value
  })})()`)
  console.log('panel after restart:', panel)
  const expect = { category: '食品饮料', levels: ['invite-level-LV2', 'invite-level-LV4'], count: '33', script: '保存配置验证话术XYZ123' }
  const got = JSON.parse(panel)
  const ok = got.category === expect.category
    && JSON.stringify(got.levels) === JSON.stringify(expect.levels)
    && got.count === expect.count
    && got.script === expect.script
  console.log(ok ? 'RESTORE OK' : 'RESTORE MISMATCH')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
