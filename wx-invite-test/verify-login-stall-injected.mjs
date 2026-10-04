/**
 * 真机验证（构造态）：页面正文停在「正在获取用户信息，请稍后…」时，
 * `waitForText` 超时必须报 **TASK_LOGIN_REQUIRED**（让用户去重新登录），而不是无用的 TASK_TIMEOUT。
 *
 * 为什么用"构造态"：快手分销后台的登录态在探针里时好时坏（cookie 快照与真实实例抢令牌），
 * 抓不到稳定复现；而这条判据读的就是**页面正文**，把正文换成平台原话即可把接线验穿
 * （正则本身另有单测）。验完刷新页面恢复原状。
 *
 * 用法：node wx-invite-test/verify-login-stall-injected.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const SQUARE = 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(4000)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const sq = tabs.find(t => /daren-square/.test(String(t.url)))
if (sq) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${sq.id}')`)
else await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`)
let page = null
for (let i = 0; i < 25 && !page; i++) { page = (await targets()).find(t => /daren-square|chrome-error/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没有页面目标'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 12; i++) {
  const url = String(await conn.ev('location.href'))
  if (/daren-square/.test(url)) break
  await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null)
  await sleep(10000)
}
console.log('页面:', String(await conn.ev('location.href')).slice(0, 80))

// 构造"壳页面"正文（平台原话）。引擎跑在"运行标签页"上，所以先把广场页激活并确认它还在，
// 再注入、再复核一次（标签页被切走时 guest 会被卸载 → 注入的内容跟着消失）。
const conn2 = await connect(page)
await conn2.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null)
await sleep(12000)
const before = await conn2.ev(`(() => { document.body.innerHTML = '<div>正在获取用户信息，请稍后…</div>'; return JSON.stringify({ url: location.href, body: String(document.body.innerText).trim().slice(0, 60) }) })()`)
console.log('注入后:', before)
conn2.close()
await sleep(1500)
const conn3 = await connect(page)
console.log('注入复核:', await conn3.ev(`String(document.body.innerText).trim().slice(0, 60)`))
conn3.close()

const steps = [{ type: 'waitForText', input: { text: '带货类目', deep: true }, timeoutMs: 20000 }]
const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: '验证-登录态停滞（构造态）', storeScope: STORE, steps })})`)
if (!created?.ok) { console.error('建任务失败:', JSON.stringify(created?.error)); process.exit(1) }
await app.call(`window.shopilot.task.run(${JSON.stringify(created.data.id)})`)

/**
 * 引擎跑在它**自己的运行标签页**上（`runTabByStore`，不一定是脚本刚激活的那个）。
 * 所以在任务运行的这段时间里，持续把"壳页面"正文注入到**每一个**页面目标上——
 * 引擎无论落在哪一页，超时那一刻读到的都是这句平台原话。
 */
const injectAll = async () => {
  const all = await targets()
  let n = 0
  // ⚠️ 两个坑都要避开：
  //   ① 应用渲染层（out/renderer/index.html）里有 <webview>，替换它的 body 会把 guest 打掉
  //      （真机踩过：报 BROWSER_NOT_READY: 店铺标签页 guest 在 45000ms 内未注册）；
  //   ② 店铺页面在 CDP 里的 type 是 **webview**，不是 page（只过滤 page 会一个都注入不到）。
  for (const t of all.filter(x => !String(x.url).includes('out/renderer/index.html') && !String(x.url).startsWith('devtools'))) {
    try {
      const c = await connect(t)
      const ok = await c.ev(`(() => { try { if (!document.body) return false; document.body.innerHTML = '<div>正在获取用户信息，请稍后…</div>'; return String(document.body.innerText).includes('正在获取用户信息') } catch { return false } })()`, 5000)
      if (ok) n++
      c.close()
    } catch { /* 目标可能在导航中，跳过 */ }
  }
  return n
}
let injectedRounds = 0
const injector = (async () => {
  for (let i = 0; i < 14; i++) {
    const n = await injectAll().catch(() => 0)
    if (n) injectedRounds++
    await sleep(1200)
  }
})()

let run = null
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  const tasks = await app.call(`window.shopilot.task.list()`)
  run = (tasks?.data || []).find(t => t.id === created.data.id)?.latestRun || null
  if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
}
await injector
console.log(`注入轮次（有命中的）: ${injectedRounds}`)
console.log('\n任务结果:', run?.status, '｜错误码:', run?.errorCode)
console.log('信息:', String(run?.errorMessage || '').slice(0, 220))
console.log(run?.errorCode === 'TASK_LOGIN_REQUIRED' ? '✅ 判据生效：报的是"请重新登录"' : '❌ 未按预期报 TASK_LOGIN_REQUIRED')
await app.call(`window.shopilot.task.delete(${JSON.stringify(created.data.id)})`).catch(() => null)

// 恢复页面
const page2 = (await targets()).find(t => /daren-square/.test(String(t.url)))
if (page2) { const c = await connect(page2); await c.ev(`location.reload()`).catch(() => null); c.close() }
app.close()
process.exit(0)
