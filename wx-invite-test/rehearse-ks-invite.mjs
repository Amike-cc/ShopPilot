/**
 * 快手达人邀约「发送前彩排」：用**面板真实生成的步骤**在真机上跑一遍，
 * 但把最后那一步「发送邀请」换掉（改成截图留档），并去掉"等抽屉关闭"。
 *
 * 为什么这么做：邀请会真实发给达人的（不可撤回）。这一步先不点，
 * 其余全部走真实页面/真实点击：筛选（类目级联 + 内容标签 + 合作信息）→ 搜索 →
 * 逐个勾选（含 minSelect=2 下限）→ 批量邀约开抽屉 → 额度预检 → 填联系方式/话术 →
 * 商品弹窗选择 → 合作标签。跑完把每步结果如实打印出来。
 * 需要真实发送时，把 PATCH_SEND 设为 false（默认 true=不发送）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const PATCH_SEND = process.env.KS_REAL_SEND !== '1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
console.log(PATCH_SEND ? '=== 彩排模式：不点「发送邀请」 ===' : '=== 真实发送模式 ===')
console.log('店铺:', ks.name, ks.id)

// 选中店铺 + 打开邀约页签（走真实 UI 路径）
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');return 1})()`)
await sleep(2500)
await ev(`(async()=>{await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2000)
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(${JSON.stringify(ks.name)})); if (c) c.click(); return 1 })()`)
await sleep(3500)
await ev(`(() => { const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务'); if(t)t.click(); return 1 })()`)
await sleep(1800)
await ev(`(() => { const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约')); if(t)t.click(); return 1 })()`)
await sleep(2200)

// 填面板：类目/二级、内容标签、合作信息、数量、联系方式、话术、商品数
await ev(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set; d ? d.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true }
  set('[data-test=invite-category]', '个护家清')
  return 1
})()`)
await sleep(1200)
await ev(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set; d ? d.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true }
  set('[data-test=invite-subcategory]', '纸品湿巾')
  set('[data-test=invite-count]', '2')
  set('[data-test=invite-batch-contact]', '刘涛')
  set('[data-test=invite-batch-phone]', '13148070563')
  set('[data-test=invite-batch-wechat]', 'amike688')
  set('[data-test=invite-script]', '您好，我们是做大促家清用品的工厂店，想邀请您合作带货：给专属高佣与免费寄样，素材我们提供、发货售后全包，价格可谈。')
  set('[data-test=invite-batch-products]', '1')
  return 1
})()`)
await sleep(1500)
// 内容标签（若未勾）+ 合作标签（抽屉里的，按档案 benefits）
await ev(`(() => { const c=document.querySelector('[data-test="invite-extra-内容标签-美妆"]'); if (c && !c.checked) c.click(); return 1 })()`)
await sleep(600)
await ev(`(() => { const c=document.querySelector('[data-test="invite-benefit-可聊高佣"]'); if (c && !c.checked) c.click(); return 1 })()`)
await sleep(1200)
console.log('面板已填；开始按钮可用:', await ev(`document.querySelector('[data-test=invite-start]')?.disabled`) === false)

// 拦截 task.create：把「发送邀请」换成截图（彩排模式）
await ev(`(() => {
  if (window.__ksPatched) return 'already'
  window.__ksOrigCreate = window.shopilot.task.create
  window.__ksRehearsal = null
  window.shopilot.task.create = async (payload) => {
    try {
      const loop = payload && payload.steps && payload.steps[0]
      if (loop && loop.type === 'loop' && loop.input && Array.isArray(loop.input.steps)) {
        const inner = loop.input.steps
        const before = inner.map(s => s.type + (s.input && s.input.text ? ':' + s.input.text : ''))
        const sendIdx = inner.findIndex(s => s.type === 'clickByText' && s.input && s.input.text === '发送邀请')
        window.__ksRehearsal = JSON.stringify({ patched: ${PATCH_SEND}, before, sendIdx })
        if (${PATCH_SEND} && sendIdx >= 0) {
          inner.splice(sendIdx, 1)
          const w = inner.findIndex(s => s.type === 'waitForGone')
          if (w >= 0) inner.splice(w, 1)
          inner.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
          loop.input.maxRounds = 1
          loop.input.stopOn = []
        }
      }
    } catch (e) { window.__ksRehearsal = 'patch-err:' + String(e && e.message) }
    return window.__ksOrigCreate(payload)
  }
  window.__ksPatched = true
  return 'patched'
})()`)

console.log('\n=== 点「开始邀约」（真实执行）===')
await ev(`document.querySelector('[data-test=invite-start]')?.click()`)
await sleep(3000)
console.log('拦截到的步骤序列:', await ev(`window.__ksRehearsal`))

// 等任务跑完（最多 6 分钟）
const t0 = Date.now()
let lastTaskId = null
for (let i = 0; i < 120; i++) {
  await sleep(4000)
  const st = JSON.parse(await ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = r.ok ? (r.data.tasks || r.data) : []
    const t = all.filter(x => String(x.name||'').includes('快手小店')).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
    if (!t) return JSON.stringify({ none: true })
    const run = t.latestRun || {}
    return JSON.stringify({ id: t.id, name: t.name, status: run.status, code: run.errorCode, msg: run.errorMessage, runId: run.id })
  })()`))
  if (st.id && st.id !== lastTaskId) { console.log('  [任务]', st.name); lastTaskId = st.id }
  if (i % 3 === 0) console.log(`  [${Math.round((Date.now()-t0)/1000)}s] ${st.status || st.none ? st.status : ''}`)
  if (['succeeded','failed','cancelled'].includes(st.status)) {
    console.log(`\n=== 任务结束：${st.status} ${st.code || ''} ${st.msg ? '— ' + String(st.msg).slice(0,200) : ''} ===`)
    // 打印该 run 的步骤结果
    console.log('\n步骤结果:')
    console.log(await ev(`(async () => {
      const r = await window.shopilot.task.runDetail ? await window.shopilot.task.runDetail(${JSON.stringify(st.runId)}) : null
      return r ? JSON.stringify(r.data, null, 1).slice(0, 4000) : '(无 runDetail API)'
    })()`))
    break
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-rehearsal.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-rehearsal.png')
ws.close()
setTimeout(() => process.exit(0), 300)
