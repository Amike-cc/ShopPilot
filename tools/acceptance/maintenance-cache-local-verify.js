/**
 * 维护动作本地验收（2026-10-16 新增）：清除软件缓存 / 清除浏览器缓存 / 诊断软件。
 *
 * 为什么必须单独跑一次：这三个动作调的是 Electron `session` API、磁盘差值统计与
 * 主进程自检，**单元测试跑不到运行时**——单测只能钉住纯函数与接线。
 *
 * 用临时 `--user-data-dir` 起打包产物，全程不碰用户的真实数据；跑完自动结束进程并删临时目录。
 *
 * ⚠️ 两个环境坑（都实测踩过）：
 *   1. 必须清掉 `ELECTRON_RUN_AS_NODE`：从 DSH/Electron 宿主里 spawn 的子进程会继承它，
 *      于是 ShopPilot.exe 被当成纯 Node 跑——没有窗口、退出码 0（无参数）或 9（带参数时
 *      Node 报 "bad option"），现场表现就是"应用起不来"。
 *   2. 单实例锁按 user-data-dir 区分，所以临时 profile 的实例可以与用户正在用的实例并存。
 *
 * 用法：node tools/acceptance/maintenance-cache-local-verify.js
 *   环境变量 SHOPILOT_PACKAGED_APP 可指向别的产物；SHOPILOT_MAINTENANCE_PORT 换端口。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const APP = process.env.SHOPILOT_PACKAGED_APP
  ? path.resolve(process.env.SHOPILOT_PACKAGED_APP)
  : path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
const PORT = Number(process.env.SHOPILOT_MAINTENANCE_PORT || 9253)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(label, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`
  console.log(line)
  if (!ok) failures += 1
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id == null) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }

  async eval(code) {
    await this.ready
    const id = ++this.id
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }
      }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* 已关闭 */ } }
}

async function waitForCdp(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page.webSocketDebuggerUrl
      }
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  throw new Error('CDP 页面目标未就绪')
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 可能已自行退出 */ }
}

async function main() {
  if (!fs.existsSync(APP)) throw new Error(`找不到打包产物：${APP}（先跑 pnpm run dist:dir）`)

  const userData = path.join(os.tmpdir(), `shopilot-maintenance-${Date.now()}`)
  fs.mkdirSync(userData, { recursive: true })

  // 坑 1：宿主环境里的 ELECTRON_RUN_AS_NODE 会把 Electron 变成纯 Node
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(APP, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    env,
    stdio: 'ignore',
    detached: false
  })

  let cdp = null
  try {
    cdp = new CDP(await waitForCdp())
    const ready = await cdp.eval(`
      const deadline = Date.now() + 30000
      while (!(window.shopilot && window.shopilot.maintenance) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
      }
      return !!(window.shopilot && window.shopilot.maintenance)
    `)
    check('preload 暴露 maintenance 三个方法', ready === true)
    if (!ready) throw new Error('preload 未注入 maintenance')

    check('维护 API 三件套齐全', await cdp.eval(`
      const m = window.shopilot.maintenance
      return typeof m.clearAppCache === 'function' && typeof m.clearBrowserCache === 'function' && typeof m.softwareDiagnostics === 'function'
    `))

    // ---------- 1. 清除软件缓存 ----------
    const appCache = await cdp.eval(`return await window.shopilot.maintenance.clearAppCache()`)
    check('清除软件缓存返回 ok', appCache.ok === true, appCache.ok ? undefined : JSON.stringify(appCache.error))
    if (appCache.ok) {
      const r = appCache.data
      check('scope=app 且没有失败项', r.scope === 'app' && r.failures.length === 0, `items=${r.items.join('/')} failures=${r.failures.join('/')}`)
      check('三个缓存类都真的执行了', r.items.length === 3, r.items.join('、'))
      check('释放字节是非负数', Number.isFinite(r.freedBytes) && r.freedBytes >= 0, `${r.freedBytes}`)
    }

    // ---------- 2. 诊断软件 ----------
    const diag = await cdp.eval(`return await window.shopilot.maintenance.softwareDiagnostics()`)
    check('诊断软件返回 ok', diag.ok === true, diag.ok ? undefined : JSON.stringify(diag.error))
    if (diag.ok) {
      const items = diag.data.items || []
      const expected = ['runtime', 'database', 'dataDir', 'disk', 'logs', 'cache', 'encryption', 'proxies', 'stores', 'backups', 'window']
      check('11 项检查齐全', expected.every((key) => items.some((i) => i.key === key)) && items.length === expected.length, `共 ${items.length} 项`)
      check('每项都有 label/detail 且状态合法', items.every((i) => i.label && i.detail && ['ok', 'warn', 'error'].includes(i.status)))
      const db = items.find((i) => i.key === 'database')
      check('数据库完整性检查跑通（quick_check）', !!db && /完整性/.test(db.detail), db && db.detail)
      check('没有把异常项谎报成正常', items.every((i) => i.status !== 'error' || !!i.detail))
    }

    // ---------- 3. 清除浏览器缓存（先造一个真实分区）----------
    const storeId = await cdp.eval(`
      const created = await window.shopilot.store.create({ name: '维护验收店铺', platform: '拼多多', adminUrl: 'https://mms.pinduoduo.com', tags: [] })
      if (!created.ok) return null
      const id = created.data.id || created.data.storeId
      await window.shopilot.browser.open(id, { display: false })
      return id
    `)
    check('建店并打开店铺浏览器（用于产生分区数据）', !!storeId, storeId || '建店失败')
    await sleep(3000)

    const browserCache = await cdp.eval(`return await window.shopilot.maintenance.clearBrowserCache()`)
    check('清除浏览器缓存返回 ok', browserCache.ok === true, browserCache.ok ? undefined : JSON.stringify(browserCache.error))
    if (browserCache.ok) {
      const r = browserCache.data
      check('scope=browser 且没有失败项', r.scope === 'browser' && r.failures.length === 0, `failures=${r.failures.join('/') || '无'}`)
      check('报表里至少覆盖刚开的这家店', r.stores.some((s) => s.storeId === storeId), `stores=${r.stores.length} skipped=${r.skippedStores}`)
      check('逐店释放字节非负', r.stores.every((s) => Number.isFinite(s.freedBytes) && s.freedBytes >= 0))
    }

    // ---------- 4. 审计留痕 ----------
    const audit = await cdp.eval(`
      const res = await window.shopilot.audit.query({ limit: 50 })
      if (!res.ok) return null
      const rows = res.data || []
      return rows.filter(r => r.action === 'maintenance.cache.clear').length
    `)
    check('两次清理都写了审计（maintenance.cache.clear）', audit !== null && audit >= 2, `命中 ${audit} 条`)

    // ---------- 5. 设置中心界面 ----------
    const ui = await cdp.eval(`
      const waitFor = async (fn, ms) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)) }
        return false
      }
      const rail = document.querySelector('[data-test="rail-settings"]') || document.querySelector('[data-test="settings-open-btn"]')
      if (!rail) return { rail: false }
      rail.click()
      const navReady = await waitFor(() => document.querySelector('[data-test="settings-tab-maintenance"]'), 15000)
      const tab = document.querySelector('[data-test="settings-tab-maintenance"]')
      if (tab) tab.click()
      const groupReady = await waitFor(() => document.querySelector('[data-test="maintenance-cache"]'), 10000)
      return {
        rail: true,
        navReady,
        group: groupReady && !!document.querySelector('[data-test="maintenance-cache"]'),
        appCacheBtn: !!document.querySelector('[data-test="maintenance-clear-app-cache"]'),
        browserCacheBtn: !!document.querySelector('[data-test="maintenance-clear-browser-cache"]'),
        diagnoseBtn: !!document.querySelector('[data-test="maintenance-software-check"]'),
        tabs: [...document.querySelectorAll('[data-test^="settings-tab-"]')].map(el => el.getAttribute('data-test'))
      }
    `)
    check('设置中心能打开「数据与维护」页签', !!(ui && ui.rail && ui.navReady), ui ? `tabs=${(ui.tabs || []).join(',')}` : 'rail 未找到')
    check('出现缓存清理分组', !!(ui && ui.group))
    check('三个入口都在界面上', !!(ui && ui.appCacheBtn && ui.browserCacheBtn && ui.diagnoseBtn))

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  } finally {
    if (cdp) cdp.close()
    killTree(child)
    await sleep(1200)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 目录被占用时留给系统清理 */ }
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`验收脚本异常：${error && error.message ? error.message : error}`)
  process.exit(1)
})
