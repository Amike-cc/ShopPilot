/**
 * 稳定性修复验证（独立临时实例，端口 9252）：
 *  A. EPIPE：从脚本以管道方式拉起应用 → 5 秒后销毁管道 → 注入 60 次渲染层 console.error
 *     → 断言：日志里 uncaughtException 不超过阈值（旧代码是 8 秒 1.1 万条递归）、应用仍存活
 *  B. 崩溃恢复：对店铺标签页与主窗口分别发 CDP Page.crash
 *     → 断言：日志出现 renderer gone 留痕、店铺标签页自动重载、主窗口自动重载后仍可用
 *  C. 标签页复用：同一店铺连跑两次任务 → 断言任务标签页数量不增长
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = '9252'
const USER_DATA = path.join(os.tmpdir(), 'shopilot-stab-verify')
const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpJson(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await cdpJson('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(method + ': ' + JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        send,
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
function mainTarget(list) { return list.find(t => t.url.includes('renderer/index.html')) }
function logFile() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return path.join(USER_DATA, 'logs', `app-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}
function countIn(pattern) {
  try { return (fs.readFileSync(logFile(), 'utf8').match(pattern) || []).length } catch { return 0 }
}

async function main() {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  const app = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  app.stdout.resume(); app.stderr.resume()
  const fails = []
  try {
    for (let i = 0; i < 40; i++) { try { await cdpJson('/json/version'); break } catch { await sleep(500) } }
    console.log('应用已启动（CDP ' + PORT + '）')

    // ---------- A. EPIPE ----------
    await sleep(3000)
    app.stdout.destroy(); app.stderr.destroy()   // 模拟终端/shell 关闭 → 管道断开
    await sleep(800)
    const t0 = mainTarget(await targets())
    const c0 = await connect(t0)
    for (let i = 0; i < 60; i++) {
      await c0.ev(`console.error('epipe-storm-probe-' + ${i})`).catch(() => { /* 主窗口可能重载，忽略 */ })
      await sleep(30)
    }
    c0.close()
    await sleep(1500)
    const uncaught = countIn(/uncaughtException/g)
    const epipeLines = countIn(/EPIPE/g)
    let alive = false
    try { await cdpJson('/json/version'); alive = true } catch { /* */ }
    console.log(`A. EPIPE 探针：uncaughtException=${uncaught} EPIPE 行=${epipeLines} 应用存活=${alive}`)
    // 旧代码在同一触发下产生 1.1 万条递归；阈值取 50（正常应为 0）
    if (uncaught > 50) fails.push(`EPIPE 异常风暴未止住（uncaughtException=${uncaught}）`)
    if (!alive) fails.push('EPIPE 探针后应用已死')

    // ---------- B. 崩溃自动恢复 ----------
    // B1) 店铺标签页：建店铺+网页标签页，Page.crash 后应自动重载
    const cm = await connect(mainTarget(await targets()))
    const storeId = await cm.ev(`(async () => {
      const c = await window.shopilot.store.create({ name: '崩溃验证店', platform: '微信小店', adminUrl: 'http://127.0.0.1:8765' })
      if (!c.ok) return 'ERR'
      await window.shopilot.browser.open(c.data.id)
      await window.shopilot.browser.display(c.data.id)
      await window.shopilot.browser.tab.create(c.data.id, 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=crash@finder')
      return c.data.id
    })()`)
    cm.close()
    await sleep(4000)
    let mockTab = (await targets()).find(t => t.url.includes('8765') && !t.url.endsWith('8765/'))
    if (!mockTab) throw new Error('店铺标签页未就绪')
    const ct = await connect(mockTab)
    ct.send('Page.crash').catch(() => { /* 连接会随崩溃断开 */ })
    await sleep(4000)
    const goneLogged = countIn(/store tab renderer gone/g)
    const reloadLogged = countIn(/store tab .* 自动重载恢复/g)
    const mockBack = (await targets()).some(t => t.url.includes('8765'))
    console.log(`B1. 店铺标签页崩溃：留痕=${goneLogged} 自动重载=${reloadLogged} 页面恢复=${mockBack}`)
    if (goneLogged < 1) fails.push('店铺标签页崩溃未留痕')
    if (reloadLogged < 1) fails.push('店铺标签页未自动重载')
    if (!mockBack) fails.push('店铺标签页崩溃后未恢复')

    // B2) 主窗口：Page.crash 后应自动重载（CDP target 重建）
    const cm2 = mainTarget(await targets())
    const cc = await connect(cm2)
    cc.send('Page.crash').catch(() => { /* */ })
    await sleep(5000)
    const mainGone = countIn(/renderer gone reason=/g)
    let mainBack = false
    for (let i = 0; i < 12; i++) {
      await sleep(700)
      const list = await targets()
      const mt = mainTarget(list)
      if (mt) { try { const cx = await connect(mt); const ok = await cx.ev('!!window.shopilot'); cx.close(); if (ok) { mainBack = true; break } } catch { /* */ } }
    }
    console.log(`B2. 主窗口崩溃：留痕=${mainGone} 自动重载后可用=${mainBack}`)
    if (mainGone < 1) fails.push('主窗口崩溃未留痕')
    if (!mainBack) fails.push('主窗口崩溃后未恢复')

    // ---------- C. 任务标签页复用 ----------
    const cm3 = await connect(mainTarget(await targets()))
    const tabCounts = await cm3.ev(`(async () => {
      const sl = await window.shopilot.store.list()
      const stores = sl.data.stores || sl.data || []
      const store = stores.find(s => s.name === '崩溃验证店')
      if (!store) return 'NO-STORE:' + JSON.stringify(stores.map(s => s.name))
      const sid = store.id
      const before = ((await window.shopilot.browser.tab.list(sid)).data.tabs || []).length
      const steps = [
        { type: 'navigate', input: { url: 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=t1' }, timeoutMs: 20000 },
        { type: 'waitForPage', input: { urlIncludes: '8765' }, timeoutMs: 15000 }
      ]
      const c = await window.shopilot.task.create({ name: '标签复用验证', storeScope: sid, steps })
      if (!c.ok) return 'CREATE-ERR:' + JSON.stringify(c.error)
      await window.shopilot.task.run(c.data.id)
      await new Promise(r => setTimeout(r, 6000))
      const mid = ((await window.shopilot.browser.tab.list(sid)).data.tabs || []).length
      const r2 = await window.shopilot.task.run(c.data.id)
      await new Promise(r => setTimeout(r, 6000))
      const after = ((await window.shopilot.browser.tab.list(sid)).data.tabs || []).length
      return JSON.stringify({ before, afterFirst: mid, afterSecond: after })
    })()`)
    cm3.close()
    console.log('C. 标签页数量:', tabCounts)
    try {
      const tc = JSON.parse(tabCounts)
      if (tc.afterSecond > tc.afterFirst) fails.push(`任务标签页未被复用（${tc.afterFirst} → ${tc.afterSecond}）`)
    } catch { fails.push('标签复用检查失败: ' + tabCounts) }
  } finally {
    try { app.kill() } catch { /* */ }
  }
  if (fails.length) { console.error('STABILITY-FAIL:', fails.join(' | ')); process.exit(1) }
  console.log('STABILITY-VERIFY: PASS')
}
main().catch(e => { console.error('STABILITY-ERROR:', e.message); process.exit(1) })
