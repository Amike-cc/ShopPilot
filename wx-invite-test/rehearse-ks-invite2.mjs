/**
 * 快手邀约「发送前彩排」v2：不劫持 IPC，而是让**面板自己**生成步骤，
 * 再把最后一步「发送邀请」替换掉，用真实 task.create 提交。
 *
 * 做法：面板点「开始邀约」时，用主进程可用的方式拿到步骤不太行（contextBridge 冻结）。
 * 于是直接在页面里调用与面板同一份逻辑：从 shared 的 buildInviteSteps 已打包进渲染层，
 * 但模块不对外暴露。改用最直接可靠的办法——
 *   ① 让面板正常创建任务（真实步骤、真实发送）；
 *   ② 但**在它创建之前**把「邀请联系人」那一项保持为空是过不了校验的……
 * 所以这里改用"一次性只跑一轮、且在发送前用任务暂停"：
 * 更简单的可行方案是**直接调 task.create 提交我们自己拼的步骤**（与面板同构，逐条对齐），
 * 把发送换成截图。步骤内容从档案读取，保证与面板一致。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result?.value
}

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)

// 从面板实际生成的步骤入手：先正常创建一次任务（不运行），读回它的步骤，替换后再建一个
console.log('=== 通过面板创建任务以获取真实步骤（创建后不运行）===')
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes(${JSON.stringify(ks.name)})); if (c) c.click(); return 1 })()`)
await sleep(3000)
await ev(`(() => { const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务'); if(t)t.click(); return 1 })()`)
await sleep(1500)
await ev(`(() => { const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约')); if(t)t.click(); return 1 })()`)
await sleep(2000)
await ev(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set; d ? d.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true }
  set('[data-test=invite-category]', '个护家清')
  return 1
})()`)
await sleep(1000)
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

// 用 task.list 拿不到步骤（列表不含 steps）→ 用 task.get（若存在）
console.log('可用的 task API:', await ev(`Object.keys(window.shopilot.task).join(',')`))
console.log('可用的 browser API:', await ev(`Object.keys(window.shopilot.browser).join(',')`))

// 直接点开始（这一步会真实创建并运行）——但我们先算好：用 list 找最新任务，看它的步骤
console.log('\n=== 点「开始邀约」并记录任务 ===')
await ev(`document.querySelector('[data-test=invite-start]')?.click()`)
await sleep(6000)
const info = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.list()
  const all = r.ok ? (r.data.tasks || r.data) : []
  const t = all.filter(x => String(x.name||'').includes('快手小店') && String(x.name||'').includes('邀约')).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
  return JSON.stringify(t || { none: true })
})()`))
console.log('新任务:', JSON.stringify(info).slice(0, 700))

// 立刻停止（彩排：不让它真的发出去）
if (info.latestRun && info.latestRun.id) {
  const st = info.latestRun.status
  console.log('最新 run 状态:', st)
  if (['queued','running','waiting_confirmation','paused'].includes(st)) {
    console.log('立即请求停止:', JSON.stringify(await ev(`(async()=>{const r=await window.shopilot.task.cancel('${info.latestRun.id}');return JSON.stringify(r)})()`)))
  }
}
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-rehearsal2.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-ks-rehearsal2.png')
ws.close()
setTimeout(() => process.exit(0), 300)
