/**
 * 复现"发送脚本前置 → 第 1 轮等「带货类目」超时"这个反复出现的问题。
 *
 * 发送脚本在开跑前会：① 把店铺第一个标签页导航到广场；② 新开「我的达人」标签页读基线（**留着且是前台**）；
 * ③ 立刻启动任务。我的最小任务（无此前置）连跑 8/8 都成功 —— 所以嫌疑在前置。
 *
 * 本脚本照抄这个前置，然后跑最小任务，并每 1.5s 采样两侧状态：
 *   · 渲染层：<webview> 的 rect / tabId / 有没有隐藏祖先
 *   · 页面内：当前 findersquare 目标的路径 + 「带货类目」命中数与 rect
 *
 * 用法：node wx-invite-test/diag-repro-preamble.mjs
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

const HOST = `(() => {
  const wv = document.querySelector('webview')
  if (!wv) return JSON.stringify({ webview: null, count: document.querySelectorAll('webview').length })
  const r = wv.getBoundingClientRect()
  let el = wv, hidden = null
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el); const rr = el.getBoundingClientRect()
    if (cs.display === 'none' || cs.visibility === 'hidden' || rr.width === 0 || rr.height === 0) { hidden = el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''); break }
    el = el.parentElement
  }
  return JSON.stringify({ count: document.querySelectorAll('webview').length, w: Math.round(r.width), h: Math.round(r.height), tabId: wv.getAttribute('data-tab-id'), src: String(wv.src).slice(-30), hidden })
})()`

const PAGE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = all.filter(e => own(e) === '带货类目')
  const rects = hits.map(e => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })
  return JSON.stringify({ path: location.pathname, ready: document.readyState, hits: hits.length, rects, micro: all.filter(e => e.tagName === 'MICRO-APP').length })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(2000)

  console.log('[1] 照抄前置：第一个标签页 → 广场')
  const tabsBefore = await app.call(`window.shopilot.browser.tab.list('${STORE}')`)
  const firstTabId = (tabsBefore?.data?.tabs || [])[0]?.id
  if (firstTabId) { await app.call(`window.shopilot.browser.navigate('${STORE}', '${firstTabId}', '${SQUARE}')`).catch(() => null); await sleep(6000) }

  console.log('[2] 新开「我的达人」标签页（留着、前台）')
  const created = await app.call(`window.shopilot.browser.tab.create('${STORE}', '${MY_INVITE}')`)
  const myTabId = created?.data?.tabId || created?.data?.id
  await sleep(9000)
  console.log('    我的达人标签:', myTabId)

  console.log('[3] 立刻启动最小任务（navigate → waitForPage → waitForText「带货类目」40s）')
  const steps = [
    { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: 'find' }, timeoutMs: 45000 },
    { type: 'waitForText', input: { text: '带货类目', deep: true }, timeoutMs: 40000 }
  ]
  const task = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: '前置复现（只读，不发邀约）', storeScope: STORE, steps })})`)
  const taskId = task.data.id
  const t0 = Date.now()
  await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)

  let run = null
  for (let i = 0; i < 45; i++) {
    await sleep(1500)
    const tasks = await app.call(`window.shopilot.task.list()`)
    run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun || null
    let host = 'n/a'
    try { host = await app.ev(HOST) } catch (e) { host = 'ERR ' + e.message.slice(0, 40) }
    let page = 'n/a'
    const t = (await targets()).find(x => /findersquare/.test(String(x.url)))
    if (t) { const c = await connect(t); try { page = await c.ev(PAGE) } catch (e) { page = 'ERR ' + e.message.slice(0, 40) } c.close() }
    if (i % 2 === 0 || run?.status !== 'running') console.log(`    +${((Date.now() - t0) / 1000).toFixed(1)}s status=${run?.status || '?'} host=${host} page=${page}`)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
  }
  console.log('[4] 结果:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 160))
  await app.call(`window.shopilot.task.delete(${JSON.stringify(taskId)})`).catch(() => null)
  if (myTabId) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${myTabId}')`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
