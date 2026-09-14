/**
 * 面板配置 + 开始邀约 + 门禁放行（真实发送）
 * 前置：店铺窗口里已有 initiate-invite 表单页（上一步已打开）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CONTACT = '测试联系人'
const WECHAT = 'test_wx_001'
const PHONE = '13800000000'
const SCRIPT = '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样，提供现成素材，发货售后我们全包。'
const PRODUCT_ID = '10000687986563'

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
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 200))
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
  // 选中微信店铺 + 任务面板
  await app.ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(c)c.click();return 1})()`)
  await sleep(1500)
  await app.ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
  await sleep(1200)
  console.log('contact:', await app.ev(setV('[data-test=invite-contact]', CONTACT)))
  console.log('wechat :', await app.ev(setV('[data-test=invite-wechat]', WECHAT)))
  console.log('phone  :', await app.ev(setV('[data-test=invite-phone]', PHONE)))
  console.log('script :', await app.ev(setV('[data-test=invite-script]', SCRIPT, true)))
  console.log('productIds:', await app.ev(setV('[data-test=invite-product-ids]', PRODUCT_ID, true)))
  await sleep(1200)
  console.log('开始按钮:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');return b?JSON.stringify({disabled:b.disabled}):'no-btn'})()`))
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b||b.disabled)return 'not-ready';b.click();return 'clicked'})()`))

  let approved = false
  for (let i = 0; i < 100; i++) {
    await sleep(3000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.filter(x => String(x.name || '').startsWith('达人邀约'))[0]
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 170) : null, runId: run.id, gate: !!document.querySelector('[data-test=confirm-deny]') })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (st.gate && !approved) {
      console.log('  门禁 → 允许（真实发送）')
      console.log('  approve:', await app.ev(`(()=>{const b=document.querySelector('[data-test=confirm-allow]');if(!b)return 'no-btn';b.click();return 'allowed'})()`))
      approved = true
    }
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      if (st.runId) {
        console.log('payload:', await app.ev(`(async () => {
          const res = await window.shopilot.task.results('${st.runId}')
          const steps = res.data.results || []
          const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
          return JSON.stringify(steps.map(norm).map(p => p.action ? { action: p.action, requested: p.requested, added: p.added, present: p.present, quota: p.quota, length: p.length, text: p.text } : p).slice(-12))
        })()`))
      }
      break
    }
  }
  await sleep(2500)
  const form = await pickLive('initiate-invite')
  if (form) {
    console.log('发送后表单页:', await form.ev(`(function(){return JSON.stringify({url:location.href.slice(0,80),body:String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)})})()`))
    form.close()
  }
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
