/**
 * v0.4.8 真实单批验证（面板路径 + 二级类目）：
 *  1) 面板写入：一级=食品饮料、二级=休闲食品、LV0-LV3、本批 40、正式话术（自动持久化）
 *  2) 点「开始邀约」
 *  3) 监听**活跃的**达人广场标签页（视口>0）：抓「已筛选」「已选择 N」与「发送成功」提示
 *  4) 看到发送成功 → 立即「停止邀约」（单批成本）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const SCRIPT = '\u60a8\u597d\uff0c\u6211\u4eec\u5728\u627e\u8fbe\u4eba\u5408\u4f5c\u5e26\u8d27\uff1a\u4e13\u5c5e\u9ad8\u4f63 + \u514d\u8d39\u5bc4\u6837\uff0c\u63d0\u4f9b\u73b0\u6210\u7d20\u6750\uff0c\u53d1\u8d27\u552e\u540e\u6211\u4eec\u5168\u5305\u3002\u65b9\u4fbf\u7684\u8bdd\u56de\u590d\u5408\u4f5c\u610f\u5411\uff0c\u6211\u4eec\u7b2c\u4e00\u65f6\u95f4\u5bc4\u6837\u3002'

async function connectApp() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  return { ev: (expr) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 160))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  }) }
}
/** 连接"当前活跃"的广场页（视口>0；每次调用重找，运行标签页会被引擎带到前台） */
async function connectLiveSquare() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('daren-square'))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return { ev: (expr) => new Promise((ok, err) => {
          const id = ++s
          pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 160))) : ok(m.result?.result?.value))
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
        }), close: () => ws.close() }
      }
    } catch { /* 目标可能刚关闭 */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await connectApp()
  // 开店窗口（保证运行标签页存在）
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(2500)
  await app.ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('1111'));c.click();return 1})()`)
  await sleep(1200)
  await app.ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\u4efb\u52a1');tab.click();return 1})()`)
  await sleep(1000)

  // 1) 面板配置（真实 UI）
  const setSel = (dt, v) => `(()=>{const el=document.querySelector('[data-test=${dt}]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`
  console.log('一级 :=', await app.ev(setSel('invite-category', '食品饮料')))
  await sleep(400)
  console.log('二级 :=', await app.ev(setSel('invite-subcategory', '休闲食品')))
  await sleep(300)
  for (let round = 0; round < 8; round++) {
    const st = JSON.parse(await app.ev(`(()=>{const want=new Set(['invite-level-LV0','invite-level-LV1','invite-level-LV2','invite-level-LV3']);const cur=[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test'));const toOff=cur.find(x=>!want.has(x));const toOn=[...want].find(x=>!cur.includes(x));const el=toOff?document.querySelector('[data-test='+toOff+']'):document.querySelector('[data-test='+toOn+']');if(!el)return JSON.stringify({done:true,cur});el.click();return JSON.stringify({clicked:toOff||toOn})})()`))
    if (st.done) { console.log('等级 :=', st.cur.join('/')); break }
    await sleep(320)
  }
  console.log('数量 :=', await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-count]');const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,'40');el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()`))
  console.log('话术 len :=', await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-script]');const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');d.set.call(el,${JSON.stringify(SCRIPT)});el.dispatchEvent(new Event('input',{bubbles:true}));return el.value.length})()`))
  await sleep(900)
  console.log('存档 :=', await app.ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.\u6296\u5e97');const v=r.data&&r.data.value;return JSON.stringify({category:v.category,subcategory:v.subcategory,count:v.count})})()`))

  // 2) 开始
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b||b.disabled)return 'not-ready';b.click();return 'started'})()`))

  // 3) 监听活跃广场页
  let sawFilter = null, sawSelected = null, sawToast = null
  const t0 = Date.now()
  while (Date.now() - t0 < 420000) {
    await sleep(800)
    const sq = await connectLiveSquare()
    if (!sq) continue
    try {
      const probe = JSON.parse(await sq.ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const text=el=>String(el.innerText||'').replace(/\s+/g,' ').trim();const f=[...document.querySelectorAll('*')].find(e=>own(e)==='\u5df2\u7b5b\u9009');const msg=document.querySelector('.select_peoples_message');const toast=[...document.querySelectorAll('div,span')].map(e=>text(e)).find(t2=>/\u53d1\u9001\u6210\u529f/.test(t2)&&t2.length<60);return JSON.stringify({filtered:f?text(f.parentElement).slice(0,140):null,selected:msg?text(msg).slice(0,30):null,toast:toast||null})})()`))
      sq.close()
      if (probe.filtered && probe.filtered !== sawFilter) { sawFilter = probe.filtered; console.log('  [已筛选]', probe.filtered) }
      if (probe.selected && probe.selected !== sawSelected) { sawSelected = probe.selected; console.log('  [计数]', probe.selected) }
      if (probe.toast) { sawToast = probe.toast; console.log('  [平台提示]', probe.toast); break }
    } catch { /* 页面切换瞬间可能失败，下轮再试 */ }
  }
  if (!sawToast) console.log('  420s 内未见发送成功提示')

  // 4) 停止
  console.log('stop:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-stop]');if(!b)return 'no-stop-btn';b.click();return 'stop-clicked'})()`))
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.filter(x => String(x.name || '').startsWith('\u8fbe\u4eba\u9080\u7ea6'))[0]
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 100) : null })
    })()`))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) { console.log('run terminal:', st); break }
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
