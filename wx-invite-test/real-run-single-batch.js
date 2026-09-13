/**
 * 真实运行验证（单批后停止）：
 *  1) 面板写入正式配置（个护家清 / LV0-LV3 / 40 位 / 正式话术）——现在会持久化
 *  2) 点「开始邀约」
 *  3) 轮询达人广场页面：抓「已筛选」标签（类目/等级生效证据）与「已选择 N 位」
 *  4) 看到「发送成功」提示 → 立即点面板「停止邀约」（只跑一批，控制真实发送量）
 *  5) 确认运行已取消
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const SCRIPT = '\u60a8\u597d\uff0c\u6211\u4eec\u5728\u627e\u8fbe\u4eba\u5408\u4f5c\u5e26\u8d27\uff1a\u4e13\u5c5e\u9ad8\u4f63 + \u514d\u8d39\u5bc4\u6837\uff0c\u63d0\u4f9b\u73b0\u6210\u7d20\u6750\uff0c\u53d1\u8d27\u552e\u540e\u6211\u4eec\u5168\u5305\u3002\u65b9\u4fbf\u7684\u8bdd\u56de\u590d\u5408\u4f5c\u610f\u5411\uff0c\u6211\u4eec\u7b2c\u4e00\u65f6\u95f4\u5bc4\u6837\u3002'

function mkConn(title) {
  return fetch(`http://127.0.0.1:${PORT}/json/list`)
    .then(r => r.json())
    .then(l => l.filter(x => x.type === 'page'))
    .then(l => {
      const t = l.find(x => x.title === title || x.url.includes(title))
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      return new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err }).then(() => {
        let s = 0
        const pend = new Map()
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
        return {
          ev: (expr) => new Promise((ok2, err2) => {
            const id = ++s
            pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error).slice(0, 160))) : ok2(m.result?.result?.value))
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
          })
        }
      })
    })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await mkConn('ShopPilot')

  // 先开店铺窗口，等达人广场标签出现后再连它
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  for (let i = 0; i < 30; i++) {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    if (l.some(x => x.type === 'page' && x.url.includes('daren-square'))) break
    await sleep(800)
  }
  const square = await mkConn('daren-square')
  await app.ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('1111'));c.click();return 1})()`)
  await sleep(1100)
  await app.ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\u4efb\u52a1');tab.click();return 1})()`)
  await sleep(1100)
  console.log('category := 个护家清 :', await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-category]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'\u4e2a\u62a4\u5bb6\u6e05');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`))
  for (let round = 0; round < 8; round++) {
    const st = JSON.parse(await app.ev(`(()=>{const want=new Set(['invite-level-LV0','invite-level-LV1','invite-level-LV2','invite-level-LV3']);const cur=[...document.querySelectorAll('[data-test^=invite-level-]')].filter(c=>c.checked).map(c=>c.getAttribute('data-test'));const toOff=cur.find(x=>!want.has(x));const toOn=[...want].find(x=>!cur.includes(x));const el=toOff?document.querySelector('[data-test='+toOff+']'):document.querySelector('[data-test='+toOn+']');if(!el)return JSON.stringify({done:true,cur});el.click();return JSON.stringify({clicked:toOff||toOn})})()`))
    if (st.done) { console.log('levels :=', st.cur); break }
    await sleep(320)
  }
  console.log('count := 40 :', await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-count]');const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,'40');el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()`))
  console.log('script len :', await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-script]');const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');d.set.call(el,${JSON.stringify(SCRIPT)});el.dispatchEvent(new Event('input',{bubbles:true}));return el.value.length})()`))
  await sleep(900)

  // ---- 2) 点开始邀约 ----
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b||b.disabled)return 'not-ready:'+String(b&&b.disabled);b.click();return 'started'})()`))

  // ---- 3) 轮询广场页面证据 ----
  let sawFilterTags = null, sawSelected = null, sawToast = null
  const t0 = Date.now()
  for (;;) {
    await sleep(600)
    const probe = await square.ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const text=el=>String(el.innerText||'').replace(/\s+/g,' ').trim();const f=[...document.querySelectorAll('*')].find(e=>own(e)==='\u5df2\u7b5b\u9009');const msg=document.querySelector('.select_peoples_message');const toast=[...document.querySelectorAll('div,span')].map(e=>text(e)).find(t2=>/\u53d1\u9001\u6210\u529f/.test(t2)&&t2.length<60);return JSON.stringify({filtered:f?text(f.parentElement).slice(0,140):null,selected:msg?text(msg).slice(0,30):null,toast:toast||null})})()`).catch(e => JSON.stringify({ err: e.message.slice(0, 60) }))
    const p = JSON.parse(probe)
    if (p.filtered && !sawFilterTags) { sawFilterTags = p.filtered; console.log('  [证据] 已筛选:', p.filtered) }
    if (p.selected && !sawSelected) { sawSelected = p.selected; console.log('  [证据] 计数:', p.selected) }
    if (p.toast && !sawToast) { sawToast = p.toast; console.log('  [证据] 平台提示:', p.toast); break }
    if (Date.now() - t0 > 300000) { console.log('  超时未见发送成功提示'); break }
  }

  // ---- 4) 立即停止邀约（单批成本）----
  console.log('stop:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-stop]');if(!b)return 'no-stop-btn';b.click();return 'stop-clicked'})()`))

  // ---- 5) 等运行终结 ----
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const st = await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.filter(x => String(x.name || '').startsWith('\u8fbe\u4eba\u9080\u7ea6'))[0]
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 90) : null })
    })()`)
    const s = JSON.parse(st)
    if (['succeeded', 'failed', 'cancelled'].includes(s.status)) {
      console.log('run terminal:', st)
      break
    }
  }
  // 存档确认（正式配置应已持久化）
  console.log('stored:', await app.ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.\u6296\u5e97');return JSON.stringify(r.data&&r.data.value)})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
