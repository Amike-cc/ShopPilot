/**
 * 受控实验：把停在 **finder-detail** 的标签页导航到广场，逐秒看地址变没变。
 *
 * 背景：真机连发反复在第 1 轮第 3 步超时（等「带货类目」），采样发现整轮里唯一挂载的
 * webview 一直停在 finder-detail —— 说明 `navigate` 步"成功"了但页面根本没跳。
 * 引擎的 navigate 对 `ERR_ABORTED` 是**吞掉**的（本意是放行重定向），
 * 若详情页有 beforeunload 守卫，loadURL 会被取消成 ERR_ABORTED，于是静默没跳。
 *
 * 用法：node wx-invite-test/diag-navigate-from-detail.mjs
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

const PROBE = `(() => JSON.stringify({ path: location.pathname, hasBeforeUnload: (() => { try { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented } catch { return null } })(), micro: document.querySelectorAll('micro-app').length }))()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const detailTab = tabs.find(t => /finder-detail/.test(String(t.url)))
  const squareTab = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  console.log('详情页标签:', detailTab && detailTab.id, '｜广场页标签:', squareTab && squareTab.id)
  const use = detailTab || squareTab
  if (!use) { console.log('没有可用的 findersquare 标签页'); process.exit(1) }

  await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${use.id}')`)
  await sleep(3000)
  let t = (await targets()).find(x => /findersquare/.test(String(x.url)))
  if (t) { const c = await connect(t); console.log('[起页]', await c.ev(PROBE)); c.close() }

  console.log('[导航] → 广场，逐秒看地址')
  const t0 = Date.now()
  let navError = null
  const navPromise = app.call(`window.shopilot.browser.navigate('${STORE}', '${use.id}', '${SQUARE}')`).catch(e => { navError = e.message; return null })
  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    const page = (await targets()).find(x => /findersquare/.test(String(x.url)))
    let path = '（无目标）'
    if (page) { const c = await connect(page); try { path = await c.ev(`location.pathname`) } catch (e) { path = 'ERR ' + e.message.slice(0, 40) } c.close() }
    console.log(`   +${((Date.now() - t0) / 1000).toFixed(0)}s path=${path}`)
    if (path === '/shop/findersquare/find') break
  }
  const result = await navPromise
  console.log('[navigate 调用结果]', JSON.stringify(result), navError ? `｜异常: ${navError}` : '')
  const final = (await targets()).find(x => /findersquare/.test(String(x.url)))
  if (final) { const c = await connect(final); console.log('[终页]', await c.ev(PROBE)); c.close() }
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
