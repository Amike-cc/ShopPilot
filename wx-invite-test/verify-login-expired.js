/**
 * 反例测试：登录态失效时，微信邀约相关入口是否给出**明确**提示（而不是静默失败/误报"筛选没生效"）
 * 现在正是未登录状态，正好验证。
 *  ① prepareInviteSquare（打开达人广场）
 *  ② 直接跑一段邀约任务（navigate 到广场 → 取人）看报错是否可读
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const out = []
const log = x => { out.push(String(x)); console.log(String(x)) }

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(3000)
await ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
await sleep(1200)

log('=== ① 打开达人广场（未登录） ===')
log('调用前先确认活动页是店铺页（非广场）')
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'')})))})()`))
log('标签页: ' + JSON.stringify(tabs.map(t => t.url.slice(0, 55))))
// 直接调 IPC，看返回的错误信息是否明确
const r1 = await ev(`(async()=>{const r=await window.shopilot.browser.prepareInviteSquare('${STORE}',{url:${JSON.stringify(SQUARE)},finderType:'直播带货者',categories:['母婴'],otherFilters:['有联系方式']});return JSON.stringify(r).slice(0,400)})()`)
log('prepareInviteSquare 返回: ' + r1)
const parsed = (() => { try { return JSON.parse(r1) } catch { return null } })()
if (parsed && parsed.ok === false) {
  const msg = parsed.error && parsed.error.message || ''
  log(msg.includes('登录已过期') ? '✓ 给出了明确的「登录已过期」提示（不是静默失败）' : '✗ 报错不明确: ' + msg)
} else {
  log('（返回 ok=true —— 可能仍处于登录态）')
}

log('\n=== ② 任务引擎在未登录时的失败信息是否可读 ===')
const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 20000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 15000 }
]
const created = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.create({ name: '反例 · 未登录取人', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
  return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
})()`))
log('create: ' + JSON.stringify(created))
if (created.ok) {
  log('run: ' + await ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok})})()`))
  for (let i = 0; i < 30; i++) {
    await sleep(3000)
    const st = JSON.parse(await ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 200) : null, runId: run.id })
    })()`))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      log('结果: ' + JSON.stringify(st))
      break
    }
  }
  await ev(`(async()=>{await window.shopilot.task.delete('${created.taskId}');return 1})()`).catch(() => {})
}
const fs = await import('fs')
fs.writeFileSync('wx-invite-test/negative-login-expired.txt', out.join('\n'))
setTimeout(() => process.exit(0), 300)
