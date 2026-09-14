/**
 * 微信小店达人邀约 —— 真实全流程（含真实发送）
 *   1) 应用广场筛选（类型/类目/其他）并回读验证
 *   2) 广场点第一个达人的「详情」→ 详情页点「邀请带货」→ 到邀约表单页
 *   3) 面板写入联系方式/话术/指定商品ID（真实 UI）
 *   4) 点「开始邀约」→ 等门禁 → 点「允许」（**真实发送**）
 *   5) 回读运行结果与页面证据
 * 用法：node real-wx-full-test.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const URL_FIND = 'https://store.weixin.qq.com/shop/findersquare/find'
const CONTACT = '测试联系人'
const WECHAT = 'test_wx_001'
const PHONE = '13800000000'
const SCRIPT = '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样，提供现成素材，发货售后我们全包。'
const PRODUCT_ID = '10000687986563'

const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

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
          send,
          ev: async (expr, awaitP = true) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP, userGesture: true })
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
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

/** 在页面里按 own 文本找一个"未被遮挡"的点并真实点击 */
async function realClickText(page, needle, log) {
  const ptRaw = await page.ev(`${ENUM_DECL}
    ;(function(){
      var NEEDLE=${JSON.stringify(needle)}
      var all=ENUM_ALL()
      var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}
      var deepAt=function(x,y){var el=document.elementFromPoint(x,y);while(el&&el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner}return el}
      for(var i=0;i<all.length;i++){var el=all[i];if(own(el)!==NEEDLE)continue;var r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue
        var xs=[0.12,0.3,0.5,0.7,0.88].map(function(f){return Math.round(r.left+r.width*f)})
        var ys=[0.5,0.25,0.75].map(function(f){return Math.round(r.top+r.height*f)})
        for(var a=0;a<xs.length;a++)for(var b=0;b<ys.length;b++){var hit=deepAt(xs[a],ys[b]);if(hit&&(hit===el||el.contains(hit)||hit.contains(el)))return JSON.stringify({ok:true,x:xs[a],y:ys[b]})}
      }
      return JSON.stringify({ok:false})
    })()`, false)
  const pt = JSON.parse(ptRaw)
  if (!pt.ok) { if (log) console.log('  找不到可点位置:', needle); return false }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' })
  await sleep(200)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  if (log) console.log('  点击', needle, '@', pt.x, pt.y)
  return true
}

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(4000)

  // ---- 1) 应用筛选 ----
  const res = await app.ev(`(async () => {
    const r = await window.shopilot.browser.prepareInviteSquare('${STORE}', {
      url: ${JSON.stringify(URL_FIND)},
      finderType: '直播带货者',
      categories: ['母婴', '美妆护肤'],
      otherFilters: ['有联系方式']
    })
    return JSON.stringify(r)
  })()`)
  console.log('筛选应用结果:', res)

  // ---- 2) 进达人详情 → 邀请带货 ----
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  await sleep(2500)
  const detailOk = await realClickText(sq, '详情', true)
  sq.close()
  if (!detailOk) throw new Error('未找到「详情」按钮')
  await sleep(6000)
  const detail = await pickLive('findersquare/finder-detail')
  if (!detail) { console.log('未进入详情页'); process.exit(1) }
  console.log('详情页 URL:', await detail.ev('location.href.slice(0,80)', false))
  const inviteOk = await realClickText(detail, '邀请带货', true)
  detail.close()
  if (!inviteOk) throw new Error('未找到「邀请带货」按钮')
  await sleep(7000)
  const form = await pickLive('findersquare/initiate-invite')
  if (!form) { console.log('未进入邀约表单页'); process.exit(1) }
  console.log('表单页 URL:', await form.ev('location.href.slice(0,90)', false))
  form.close()

  // ---- 3) 面板写入配置（真实 UI）----
  const setV = (sel, val, isText) => `(() => {
    const el = document.querySelector('${sel}')
    if (!el) return 'missing'
    const proto = ${isText ? 'window.HTMLTextAreaElement.prototype' : 'window.HTMLInputElement.prototype'}
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value.length
  })()`
  // 先选中微信小店店铺（邀约面板按店铺）
  console.log('select store:', await app.ev(`(()=>{const c=[...document.querySelectorAll('.store-card')].find(e=>String(e.innerText||'').includes('微信小店测试'));if(!c)return 'no-card';c.click();return 'clicked'})()`))
  await sleep(1500)
  const tab = await app.ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
  await sleep(1200)
  console.log('contact:', await app.ev(setV('[data-test=invite-contact]', CONTACT)))
  console.log('wechat :', await app.ev(setV('[data-test=invite-wechat]', WECHAT)))
  console.log('phone  :', await app.ev(setV('[data-test=invite-phone]', PHONE)))
  console.log('script :', await app.ev(setV('[data-test=invite-script]', SCRIPT, true)))
  console.log('productIds:', await app.ev(setV('[data-test=invite-product-ids]', PRODUCT_ID, true)))
  await sleep(1000)
  const ready = await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');return b?JSON.stringify({disabled:b.disabled}):'no-btn'})()`)
  console.log('开始邀约按钮:', ready)
  if (ready.includes('"disabled":true')) { console.log('按钮不可用，停止'); process.exit(1) }

  // ---- 4) 开始邀约 → 门禁 → 允许（真实发送）----
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');b.click();return 'clicked'})()`))
  let approved = false
  for (let i = 0; i < 120; i++) {
    await sleep(3000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.filter(x => String(x.name || '').startsWith('达人邀约'))[0]
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      const gate = !!document.querySelector('[data-test=confirm-deny]')
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 160) : null, runId: run.id, gate })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (st.gate && !approved) {
      console.log('  门禁出现 → 点「允许」（真实发送）')
      console.log('  approve:', await app.ev(`(()=>{const b=document.querySelector('[data-test=confirm-allow]');if(!b)return 'no-btn';b.click();return 'allowed'})()`))
      approved = true
    }
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      if (st.runId) {
        console.log('payload:', await app.ev(`(async () => {
          const res = await window.shopilot.task.results('${st.runId}')
          const steps = res.data.results || []
          const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
          return JSON.stringify(steps.map(norm).map(p => p.action ? { action: p.action, requested: p.requested, added: p.added, present: p.present, quota: p.quota, length: p.length } : p).slice(-10))
        })()`))
      }
      break
    }
  }
  // ---- 5) 页面证据 ----
  await sleep(2000)
  const after = await pickLive('store.weixin.qq.com')
  if (after) {
    console.log('发送后页面:', await after.ev(`(function(){return JSON.stringify({url:location.href.slice(0,90),body:String(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,220)})})()`, false))
    after.close()
  }
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
