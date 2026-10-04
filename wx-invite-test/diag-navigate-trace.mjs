/**
 * 定向实验：带发送脚本同样的前置（新开「我的达人」页并留前台），跑一个**只有 navigate 的任务**，
 * 每秒采样：
 *   · 渲染层实际挂载的 webview（tabId / src）
 *   · browser.state()：activeTabId + 每个标签页的 guestAttached
 *   · 当前 findersquare 目标的 location.pathname
 * 目的：判定引擎的 `wc.loadURL` 到底作用在哪个标签页/guest 上，以及为什么页面没跳。
 *
 * 用法：node wx-invite-test/diag-navigate-trace.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const MY_INVITE = 'https://store.weixin.qq.com/shop/findersquare/my-invite'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 10000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 160))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(2000)

  console.log('[1] 前置：第一个标签页 → 广场')
  const tabs0 = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  if (tabs0[0]) { await app.call(`window.shopilot.browser.navigate('${STORE}', '${tabs0[0].id}', '${SQUARE}')`).catch(() => null); await sleep(5000) }

  console.log('[2] 前置：新开「我的达人」（留前台）')
  const created = await app.call(`window.shopilot.browser.tab.create('${STORE}', '${MY_INVITE}')`)
  const myTabId = created?.data?.tabId || created?.data?.id
  await sleep(9000)

  const snapshot = async () => {
    let host = 'n/a'
    try { host = await app.ev(`(() => { const w = document.querySelector('webview'); return w ? JSON.stringify({ tab: w.getAttribute('data-tab-id'), src: String(w.src).slice(-40), n: document.querySelectorAll('webview').length }) : 'none' })()`) } catch (e) { host = 'ERR' }
    let state = 'n/a'
    try {
      const st = await app.call(`window.shopilot.browser.state()`)
      const s = st?.data?.stores?.find(x => x.storeId === '${STORE}')
      state = JSON.stringify({ active: s?.activeTabId, tabs: (s?.tabs || []).filter(t => /findersquare/.test(String(t.url))).map(t => `${t.id.slice(-6)}:${t.url.split('/').pop().slice(0, 18)}:guest=${t.guestAttached}`) })
    } catch (e) { state = 'ERR' }
    let path = 'n/a'
    const t = (await targets()).find(x => /findersquare/.test(String(x.url)))
    if (t) { const c = await connect(t); try { path = await c.ev(`location.pathname`) } catch (e) { path = 'ERR' } c.close() }
    return { host, state, path }
  }

  console.log('[3] 跑「只有 navigate + waitMs」的任务')
  const steps = [
    { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
    { type: 'waitMs', input: { ms: 20000 }, timeoutMs: 30000 }
  ]
  const task = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: '导航追踪（只读）', storeScope: STORE, steps })})`)
  const taskId = task.data.id
  const t0 = Date.now()
  await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)
  for (let i = 0; i < 14; i++) {
    await sleep(1500)
    const s = await snapshot()
    console.log(`   +${((Date.now() - t0) / 1000).toFixed(1)}s path=${s.path} host=${s.host}\n        state=${s.state}`)
  }
  const tasks = await app.call(`window.shopilot.task.list()`)
  const run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun
  console.log('[4] 任务:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 120))
  await app.call(`window.shopilot.task.delete(${JSON.stringify(taskId)})`).catch(() => null)
  if (myTabId) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${myTabId}')`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
