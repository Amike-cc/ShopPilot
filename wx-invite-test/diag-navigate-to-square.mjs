/**
 * 受控实验：把"停在邀约表单页"的标签页导航到广场，测**筛选区多久才渲染出来**。
 *
 * 为什么做：真机连发时第 1 轮卡在 `waitForText「带货类目」超 40s`（而同一环境下彩排刚跑通 3 轮）。
 * 要区分是"页面渲染真的慢"还是"导航没生效/标签页没挂载"，只能量时间。
 *
 * 用法：node wx-invite-test/diag-navigate-to-square.mjs
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

const STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = all.map(e => own(e)).filter(Boolean).join(' ')
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  return JSON.stringify({
    url: location.pathname,
    readyState: document.readyState,
    hasCat: all.some(e => own(e) === '带货类目'),
    typeTabs: all.filter(e => /^(全部带货者|直播带货者|短视频带货者|公众号带货者)$/.test(own(e))).length,
    rows: all.filter(e => e.tagName === 'TR' && vis(e)).length,
    microApps: all.filter(e => e.tagName === 'MICRO-APP').length,
    head: text.replace(/\\s+/g, ' ').slice(0, 90)
  }, null, 1)
})()`

async function readActive() {
  const t = (await targets()).find(x => /findersquare/.test(String(x.url)))
  if (!t) return { error: '该标签页未挂载（无 CDP 目标）' }
  const c = await connect(t)
  const s = JSON.parse(await c.ev(STATE))
  c.close()
  return s
}

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const formTab = tabs.find(t => /initiate-invite/.test(String(t.url)))
  const squareTab = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  console.log('表单页标签:', formTab && formTab.id, '｜广场页标签:', squareTab && squareTab.id)

  const useTab = formTab || squareTab
  if (!useTab) { console.log('没有可用的 findersquare 标签页'); process.exit(1) }

  console.log('\n[1] 激活', useTab.id, '并读当前状态')
  await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${useTab.id}')`)
  await sleep(3500)
  console.log('    ', JSON.stringify(await readActive()))

  console.log('\n[2] 导航到广场，开始计时（每 2s 采样一次，最多 90s）')
  const t0 = Date.now()
  await app.call(`window.shopilot.browser.navigate('${STORE}', '${useTab.id}', '${SQUARE}')`)
  let firstSeen = null
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    let s
    try { s = await readActive() } catch (e) { s = { error: e.message.slice(0, 60) } }
    const elapsed = Date.now() - t0
    if (i % 3 === 0 || s.hasCat) console.log(`    +${(elapsed / 1000).toFixed(1)}s ${JSON.stringify(s)}`)
    if (s.hasCat && firstSeen === null) { firstSeen = elapsed; console.log(`    ✅ 筛选区出现：+${(elapsed / 1000).toFixed(1)}s`); break }
  }
  if (firstSeen === null) console.log('    ❌ 90s 内始终没渲染出筛选区')
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
