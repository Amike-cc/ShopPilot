/**
 * 决定性测量：跑一个「navigate + waitMs」任务，每 1s 同时打印
 *   · 主进程认为的状态：activeTabId、该店铺所有 finder 标签页（含 guestAttached）
 *   · 渲染层实际挂载的 webview 元素（data-tab-id 列表）
 *   · CDP 里所有 findersquare 目标的 URL
 * 目的：判定"主进程的活动标签页"与"渲染层真正挂载的标签页"是否一致。
 *
 * 用法：node wx-invite-test/diag-tab-sync.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
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

  const steps = [
    { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
    { type: 'waitMs', input: { ms: 15000 }, timeoutMs: 25000 }
  ]
  const task = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: '标签页同步测量（只读）', storeScope: STORE, steps })})`)
  const taskId = task.data.id
  const t0 = Date.now()
  await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)

  for (let i = 0; i < 12; i++) {
    await sleep(1200)
    let mounted = 'n/a'
    try { mounted = await app.ev(`JSON.stringify([...document.querySelectorAll('webview')].map(w => ({ tab: w.getAttribute('data-tab-id'), src: String(w.src).slice(-28) })))`) } catch (e) { mounted = 'ERR' }
    let mainState = 'n/a'
    try {
      const st = await app.call(`window.shopilot.browser.state()`)
      const s = (st?.data?.stores || []).find(x => x.storeId === '${STORE}')
      const finder = (s?.tabs || []).filter(t => /finder/.test(String(t.url || '')))
      mainState = JSON.stringify({ active: s?.activeTabId, finder: finder.map(t => `${t.id.slice(-6)}:${String(t.url).split('/').pop().slice(0, 16)}:g=${t.guestAttached ? 1 : 0}`) })
    } catch (e) { mainState = 'ERR ' + e.message.slice(0, 40) }
    let cdps = 'n/a'
    try { cdps = JSON.stringify((await targets()).filter(t => /findersquare/.test(String(t.url))).map(t => String(t.url).split('/').pop().slice(0, 22))) } catch (e) { cdps = 'ERR' }
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s\n   渲染层挂载=${mounted}\n   主进程=${mainState}\n   CDP目标=${cdps}`)
  }
  const tasks = await app.call(`window.shopilot.task.list()`)
  const run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun
  console.log('[结果]', run?.status, run?.errorCode || '-')
  await app.call(`window.shopilot.task.delete(${JSON.stringify(taskId)})`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
