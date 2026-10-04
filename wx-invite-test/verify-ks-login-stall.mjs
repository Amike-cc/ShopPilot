/**
 * 真机验证：页面"壳住"（正文停在「正在获取用户信息，请稍后…」）时，
 * `waitForText` 超时必须报 **TASK_LOGIN_REQUIRED**（"请重新登录"），而不是一句无用的 TASK_TIMEOUT。
 *
 * 用法：node wx-invite-test/verify-ks-login-stall.mjs
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
if (!renderer) { console.error('未找到渲染层'); process.exit(1) }
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(4000)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const sq = tabs.find(t => /daren-square/.test(String(t.url)))
if (sq) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${sq.id}')`)
else await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`)
let page = null
for (let i = 0; i < 20 && !page; i++) { page = (await targets()).find(t => /daren-square/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没有广场页目标'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 10; i++) {
  let st = JSON.parse(await conn.ev(`(() => { const b=String(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim(); return JSON.stringify({ url: location.href, bodyLen: b.length, head: b.slice(0,80) }) })()`))
  // 刚挂载的 webview 可能是 chrome-error（导航还没完成）→ 强制导一次再看
  if (!/daren-square/.test(st.url)) {
    console.log('当前不是广场页（' + st.url.slice(0, 60) + '）→ 强制导航')
    await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null)
    await sleep(12000)
    continue
  }
  console.log('页面状态:', JSON.stringify(st))
  if (st.bodyLen > 0) break
  await sleep(2000)
}
conn.close()

// 任务：只等「带货类目」——壳页面里永远等不到，期望报 TASK_LOGIN_REQUIRED
const steps = [{ type: 'waitForText', input: { text: '带货类目', deep: true }, timeoutMs: 8000 }]
const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: '验证-登录态停滞判据', storeScope: STORE, steps })})`)
if (!created?.ok) { console.error('建任务失败:', JSON.stringify(created?.error)); process.exit(1) }
await app.call(`window.shopilot.task.run(${JSON.stringify(created.data.id)})`)
let run = null
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  const tasks = await app.call(`window.shopilot.task.list()`)
  run = (tasks?.data || []).find(t => t.id === created.data.id)?.latestRun || null
  if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
}
console.log('\n任务结果:', run?.status, '｜错误码:', run?.errorCode, '｜信息:', String(run?.errorMessage || '').slice(0, 200))
await app.call(`window.shopilot.task.delete(${JSON.stringify(created.data.id)})`).catch(() => null)
app.close()
process.exit(0)
