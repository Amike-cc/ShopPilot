/**
 * 微信小店「全自动连续邀约」真实测试 + 逐轮目标达人监控
 *  - 面板写入配置（筛选只用 母婴，避开被遮挡的类目）
 *  - 点开始邀约 → 真实发送、无门禁
 *  - 每 2 秒记录：运行状态 + 当前标签页 URL（抓 finderUsername，判断是否重复邀同一人）
 *  - 同一达人连续出现两次 → 立即停止（防重复邀约）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CONTACT = '测试联系人'
const WECHAT = 'test_wx_001'
const PHONE = '13800000000'
const SCRIPT = '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样，提供现成素材，发货售后我们全包。'
const PRODUCT_ID = '10000687986563'
const MAX_MINUTES = 20

async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
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
        return {
          ev: async (expr) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
            if (res.exceptionDetails) return null
            return res.result.value
          },
          close: () => ws.close()
        }
      }
    } catch { /* next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app')
  const setV = (sel, val, isText) => `(() => {
    const el = document.querySelector('${sel}')
    if (!el) return 'missing'
    const proto = ${isText ? 'window.HTMLTextAreaElement.prototype' : 'window.HTMLInputElement.prototype'}
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value.length
  })()`
  await app.ev(`(async()=>{await window.shopilot.browser.open('store_4eb9b43cffeee0094041894a9f1f93bf');return 1})()`)
  await sleep(3000)
  await app.ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
  await sleep(1500)
  await app.ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
  await sleep(1200)
  console.log('contact:', await app.ev(setV('[data-test=invite-contact]', CONTACT)))
  console.log('wechat :', await app.ev(setV('[data-test=invite-wechat]', WECHAT)))
  console.log('phone  :', await app.ev(setV('[data-test=invite-phone]', PHONE)))
  console.log('script :', await app.ev(setV('[data-test=invite-script]', SCRIPT, true)))
  console.log('productIds:', await app.ev(setV('[data-test=invite-product-ids]', PRODUCT_ID, true)))
  // 筛选：类型=直播带货者、类目只留 母婴、其他=有联系方式
  await app.ev(`(()=>{const el=document.querySelector('[data-test=invite-finder-type]');const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(el,'直播带货者');el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`)
  await sleep(300)
  console.log('cats → 只留母婴:', await app.ev(`(()=>{
    const chips=[...document.querySelectorAll('[data-test^=invite-finder-category-]')]
    for(const c of chips){ const name=c.getAttribute('data-test').replace('invite-finder-category-',''); const want=(name==='母婴'); if(c.checked!==want) c.click() }
    return JSON.stringify(chips.filter(c=>c.checked).map(c=>c.getAttribute('data-test')))
  })()`))
  await sleep(300)
  console.log('others → 有联系方式:', await app.ev(`(()=>{
    const chips=[...document.querySelectorAll('[data-test^=invite-finder-other-]')]
    for(const c of chips){ const name=c.getAttribute('data-test').replace('invite-finder-other-',''); const want=(name==='有联系方式'); if(c.checked!==want) c.click() }
    return JSON.stringify(chips.filter(c=>c.checked).map(c=>c.getAttribute('data-test')))
  })()`))
  await sleep(1200)
  console.log('开始按钮:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');return b?JSON.stringify({disabled:b.disabled}):'no-btn'})()`))
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b||b.disabled)return 'not-ready';b.click();return 'clicked'})()`))

  // 监控
  const seen = []
  let stopped = false
  const t0 = Date.now()
  while (Date.now() - t0 < MAX_MINUTES * 60000) {
    await sleep(2000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.filter(x => String(x.name || '').startsWith('达人邀约'))[0]
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 150) : null, runId: run.id })
    })()`))
    // 当前标签页 URL（抓 finderUsername）
    const urls = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf');return JSON.stringify((r.data.tabs||[]).map(t=>String(t.url||'')))})()`))
    const detail = urls.find(u => u.includes('finderUsername='))
    if (detail) {
      const m = /finderUsername=([A-Za-z0-9_\-]+)/.exec(detail)
      const u = m ? m[1] : null
      if (u && (seen.length === 0 || seen[seen.length - 1].u !== u)) {
        seen.push({ u, at: new Date().toLocaleTimeString() })
        console.log(`  [第 ${seen.length} 位] ${u.slice(0, 24)}… @ ${new Date().toLocaleTimeString()}`)
      }
    }
    if (st.status === 'failed' || st.status === 'succeeded' || st.status === 'cancelled') {
      console.log('run terminal:', JSON.stringify(st))
      if (st.runId) {
        console.log('loop payload:', await app.ev(`(async () => {
          const res = await window.shopilot.task.results('${st.runId}')
          const steps = res.data.results || []
          const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
          const loop = steps.map(norm).find(p => p.action === 'loop')
          return JSON.stringify(loop || { note: 'no loop payload' })
        })()`))
      }
      break
    }
    // 同一达人连续两轮 = 可能重复邀约 → 立刻停
    if (seen.length >= 3 && seen[seen.length - 1].u === seen[seen.length - 2].u) {
      console.log('⚠ 检测到连续两轮同一达人 → 立即停止')
      await app.ev(`(async()=>{const r=await window.shopilot.task.list();const all=Array.isArray(r.data)?r.data:[];const t=all.filter(x=>String(x.name||'').startsWith('达人邀约'))[0];const run=t&&(t.latestRun||(t.runs||[])[0]||{});await window.shopilot.task.cancel(run.id);return 1})()`)
      stopped = true
      break
    }
  }
  console.log('本轮共触及达人：', seen.length, stopped ? '(人工提前停止)' : '')
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
