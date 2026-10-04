/**
 * 复现实验：跑一个最小任务（navigate → waitForPage → waitForText「带货类目」），
 * 同时在**两侧**采样，判定"元素在不在 / 可不可见"：
 *   · 渲染层：<webview> 的 rect 与祖先的 display/visibility（webview 有没有被布局）
 *   · 页面内：`带货类目` 在不在 deep DOM、它自己的 rect 是多少
 *
 * 目的：真机连发时 `waitForText「带货类目」超 40s`，而手动导航 2s 就渲染好 —— 要判定
 * 是"页面没渲染"还是"渲染了但元素不可见（rect=0）"。后者说明运行标签页的 webview 没被布局。
 *
 * 用法：node wx-invite-test/diag-visibility-race.mjs
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
  const ev = async (x, timeoutMs = 15000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 渲染层：webview 自己的 rect + 祖先链上是否有 display:none / visibility:hidden / 0 尺寸 */
const HOST_STATE = `(() => {
  const wv = document.querySelector('webview')
  if (!wv) return JSON.stringify({ webview: null })
  const r = wv.getBoundingClientRect()
  const chain = []
  let el = wv
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el)
    const rr = el.getBoundingClientRect()
    chain.push({ tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''), display: cs.display, visibility: cs.visibility, opacity: cs.opacity, w: Math.round(rr.width), h: Math.round(rr.height) })
    el = el.parentElement
  }
  return JSON.stringify({ webview: { w: Math.round(r.width), h: Math.round(r.height), tabId: wv.getAttribute('data-tab-id') }, hiddenAncestors: chain.filter(c => c.display === 'none' || c.visibility === 'hidden' || c.w === 0 || c.h === 0).slice(0, 4) })
})()`

/** 页面内：文案在不在 + 它的 rect */
const PAGE_STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = all.filter(e => own(e) === '带货类目')
  const rects = hits.map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(e).display, visibility: getComputedStyle(e).visibility } })
  const wv = document.querySelector('webview')
  return JSON.stringify({ path: location.pathname, readyState: document.readyState, hitCount: hits.length, rects: rects.slice(0, 2), viewport: { w: innerWidth, h: innerHeight }, hasWebviewEl: !!wv })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  console.log('[0] 跑之前 渲染层:', await app.ev(HOST_STATE))

  const steps = [
    { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: 'find' }, timeoutMs: 45000 },
    { type: 'waitForText', input: { text: '带货类目', deep: true }, timeoutMs: 40000 }
  ]
  const ITER = Math.max(1, Number(process.env.ITER || 8))
  let fails = 0
  for (let n = 1; n <= ITER; n++) {
    const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: `可见性复现#${n}（只读，不发邀约）`, storeScope: STORE, steps })})`)
    if (!created?.ok) throw new Error('创建失败: ' + JSON.stringify(created?.error))
    const taskId = created.data.id
    const t0 = Date.now()
    await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)

    const samples = []
    let run = null
    for (let i = 0; i < 40; i++) {
      await sleep(1200)
      const tasks = await app.call(`window.shopilot.task.list()`)
      run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun || null
      let host = 'n/a'
      try { host = await app.ev(HOST_STATE) } catch (e) { host = 'ERR ' + e.message.slice(0, 40) }
      let page = 'n/a'
      const t = (await targets()).find(x => /findersquare/.test(String(x.url)))
      if (t) { const c = await connect(t); try { page = await c.ev(PAGE_STATE) } catch (e) { page = 'ERR ' + e.message.slice(0, 40) } c.close() }
      samples.push({ at: Date.now() - t0, host, page })
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
    }
    const ms = Date.now() - t0
    const ok = run?.status === 'succeeded'
    if (!ok) fails++
    console.log(`\n[${n}/${ITER}] ${ok ? '✅ succeeded' : '❌ ' + run?.status + ' ' + (run?.errorCode || '')}  ${ms}ms  ${String(run?.errorMessage || '').slice(0, 120)}`)
    if (!ok) {
      for (const s of samples.slice(-4)) console.log(`     +${(s.at / 1000).toFixed(1)}s 宿主=${s.host}\n           页面=${s.page}`)
    }
    await app.call(`window.shopilot.task.delete(${JSON.stringify(taskId)})`).catch(() => null)
    await sleep(1500)
  }
  console.log(`\n汇总: ${ITER - fails}/${ITER} 成功`)
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
