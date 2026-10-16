/**
 * 浏览器视图注册真机验收（2026-10-16 新增，用户实报回归）。
 *
 * 为什么必须单独跑一次：这条 bug 只在**真实用户路径**上出现——点侧栏店铺卡片开店时，
 * 浏览器面板已经可见，`<webview>` 元素走同步 attach 快路径，`did-attach` 触发的那一刻
 * `getWebContentsId()` 还读到 0（约 40ms 后才可读）。用 IPC `browser.open` 开店时元素在隐藏
 * 容器里挂载，attach 被推迟，反而读得到——所以"用 IPC 开店"的验收永远抓不到它。
 *
 * 本脚本因此**只走点卡片这条路**，断言：
 *   1. 点卡片开店后，活动标签页在 10 秒内真的被注册（主进程 guestAttached=true）；
 *   2. 浮层不出现"未就绪"，尤其不出现旧的"无法读取页面进程标识"；
 *   3. 首次导航（pendingUrl）真的落到页面上（元素 URL 变成平台地址）；
 *   4. 关店重开（restoreTabs 恢复路径）同样能注册、并把 URL 恢复回来。
 *
 * 用法：node tools/acceptance/webview-attach-local-verify.js
 *   环境变量 SHOPILOT_PACKAGED_APP 可指向别的产物；SHOPILOT_WEBVIEW_PORT 换端口。
 * ⚠️ 必须清掉 `ELECTRON_RUN_AS_NODE`（从 DSH/Electron 宿主 spawn 会继承它，ShopPilot.exe
 *    会被当成纯 Node 跑，表现为"应用起不来"）；脚本内已自行删除。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const APP = process.env.SHOPILOT_PACKAGED_APP
  ? path.resolve(process.env.SHOPILOT_PACKAGED_APP)
  : path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
const PORT = Number(process.env.SHOPILOT_WEBVIEW_PORT || 9254)
const TARGET_URL = 'https://mms.pinduoduo.com/mallcenter/info/main/index'
const ATTACH_BUDGET_MS = 10_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
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

/** 只认主窗口：店铺 guest 页的 URL 里也可能含 index.html（redirectUrl 参数），踩过。 */
async function waitForMainWindowCdp(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        const main = targets.find((t) => t.type === 'page' && /app\.asar/i.test(t.url || '') && t.webSocketDebuggerUrl)
        if (main) return main.webSocketDebuggerUrl
      }
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  throw new Error('CDP 主窗口目标未就绪')
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 可能已自行退出 */ }
}

const SNAPSHOT = (storeId) => `
  const els = [...document.querySelectorAll('webview')]
  const el = els[0]
  let guestId = 0, url = '', title = ''
  if (el) {
    try { guestId = Number(el.getWebContentsId()) } catch { guestId = 0 }
    try { url = String(el.getURL() || '') } catch { url = '' }
    try { title = String(el.getTitle() || '') } catch { title = '' }
  }
  const st = await window.shopilot.browser.state()
  const row = (st.data?.stores || []).find(s => s.storeId === ${JSON.stringify(storeId)})
  const tabs = row?.tabs || []
  const active = tabs.find(t => t.id === row?.activeTabId) || tabs[0]
  const diag = document.querySelector('[data-test="webview-diagnostics"]')
  return {
    webviews: els.length,
    guestId,
    url: url.slice(0, 90),
    title: title.slice(0, 40),
    tabUrl: String(active?.url || '').slice(0, 90),
    attached: active?.guestAttached === true,
    overlay: diag ? diag.innerText.replace(/\\n/g, ' | ').slice(0, 160) : ''
  }
`

/** 等"注册成功"；返回 { ms, snapshot }（超时则 ms=null） */
async function waitForAttached(cdp, storeId, budgetMs = ATTACH_BUDGET_MS) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < budgetMs) {
    last = await cdp.eval(SNAPSHOT(storeId))
    if (last.attached) return { ms: Date.now() - started, snapshot: last, overlay: last.overlay }
    await sleep(200)
  }
  return { ms: null, snapshot: last, overlay: last?.overlay || '' }
}

async function main() {
  if (!fs.existsSync(APP)) throw new Error(`找不到打包产物：${APP}（先跑 pnpm run dist:dir）`)

  const userData = path.join(os.tmpdir(), `shopilot-webview-attach-${Date.now()}`)
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(APP, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { env, stdio: 'ignore' })
  let cdp = null
  try {
    cdp = new CDP(await waitForMainWindowCdp())
    await cdp.eval(`const d = Date.now() + 30000; while (!(window.shopilot && window.shopilot.browser) && Date.now() < d) { await new Promise(r => setTimeout(r, 200)) } return true`)

    // 建店走**应用自己的"添加店铺"对话框**：裸 IPC 建店不会触发应用的列表刷新动作，
    // 侧栏不会出现店铺卡片（踩过），而真实用户路径本来就是点这个按钮。
    const dialog = await cdp.eval(`
      // 等界面渲染完（刚启动时侧栏还没出来，赶早找按钮会得到 NO_OPENER）
      let opener = null
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        opener = document.querySelector('.add-store-button') || document.querySelector('[data-test="rail-new"]')
        if (opener) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (!opener) return 'NO_OPENER'
      opener.click()
      const d = Date.now() + 5000
      while (!document.querySelector('[data-test="store-create-dialog"]') && Date.now() < d) { await new Promise(r => setTimeout(r, 100)) }
      const name = document.querySelector('[data-test="store-name"]')
      const platform = document.querySelector('[data-test="platform-select"]')
      const adminUrl = document.querySelector('[data-test="admin-url"]')
      const form = document.querySelector('[data-test="store-create-dialog"] form')
      if (!name || !platform || !adminUrl || !form) return 'NO_FIELDS'
      const setValue = (el, value) => {
        el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      setValue(platform, '拼多多')
      await new Promise(r => setTimeout(r, 100))
      setValue(name, '视图注册验收店')
      setValue(adminUrl, ${JSON.stringify(new URL(TARGET_URL).origin)})
      await new Promise(r => setTimeout(r, 100))
      form.requestSubmit()
      return 'SUBMITTED'
    `)
    check('通过「添加店铺」对话框建店', dialog === 'SUBMITTED', String(dialog))

    // 等侧栏出现店铺卡片（真实用户入口），并从卡片上取店 id
    let storeId = ''
    for (let i = 0; i < 40; i++) {
      storeId = await cdp.eval(`
        const card = document.querySelector('[data-test="store-card"]')
        return card ? String(card.getAttribute('data-store-id') || '') : ''
      `)
      if (storeId) break
      await sleep(400)
    }
    check('侧栏出现店铺卡片（真实用户入口）', Boolean(storeId), storeId ? String(storeId).slice(0, 20) : 'cards=0')
    if (!storeId) throw new Error('建店后侧栏没有店铺卡片，后续步骤无意义')

    // === 核心：点卡片开店（用户实报的那条路）===
    const clicked = await cdp.eval(`
      const card = document.querySelector('[data-test="store-card"]')
      if (!card) return false
      card.click()
      return true
    `)
    check('已点击店铺卡片', clicked === true)

    const first = await waitForAttached(cdp, storeId)
    check('点卡片开店后 10 秒内真的注册上 guest（用户实报回归）', first.ms !== null, first.ms === null ? `未注册，浮层=${first.overlay || '无'}` : `${first.ms}ms`)
    check('浮层没有出现"无法读取页面进程标识"（旧故障文案不许回来）', !String(first.overlay).includes('无法读取页面进程标识'), first.overlay || '无浮层')
    check('注册后元素能读到 guest id', first.snapshot.guestId > 0, `guestId=${first.snapshot.guestId}`)

    // === 首次打开：新店直接落到自己的后台地址（不再给一张空白页）===
    let landed = null
    for (let i = 0; i < 40; i++) {
      landed = await cdp.eval(SNAPSHOT(storeId))
      if (landed.url && landed.url !== 'about:blank') break
      await sleep(500)
    }
    check('新店首次打开就载入平台地址（不是停在 about:blank）', Boolean(landed && landed.url !== 'about:blank'), String(landed?.url).slice(0, 70))

    // === 导航到具体页面后关店重开：restoreTabs 恢复路径也要能注册 ===
    const navigated = await cdp.eval(`
      const st = await window.shopilot.browser.state()
      const row = (st.data?.stores || []).find(s => s.storeId === ${JSON.stringify(storeId)})
      const tabId = row?.activeTabId || row?.tabs?.[0]?.id
      const r = await window.shopilot.browser.navigate(${JSON.stringify(storeId)}, tabId, ${JSON.stringify(TARGET_URL)})
      return r.ok
    `)
    check('导航到指定页面成功', navigated === true)
    let loaded = null
    for (let i = 0; i < 40; i++) {
      loaded = await cdp.eval(SNAPSHOT(storeId))
      if (String(loaded.url).includes('pinduoduo') && loaded.url !== 'about:blank') break
      await sleep(500)
    }
    check('页面真的载入了平台地址', Boolean(loaded && String(loaded.url).includes('pinduoduo')), String(loaded?.url).slice(0, 70))

    await cdp.eval(`await window.shopilot.browser.close(${JSON.stringify(storeId)}); return true`)
    await sleep(1200)
    // 关店后直接读一份数据库副本：恢复路径读到的就是这张表
    try {
      const { DatabaseSync } = require('node:sqlite')
      const copy = path.join(os.tmpdir(), `shopilot-webview-tabs-${Date.now()}.db`)
      fs.copyFileSync(path.join(userData, 'shopilot.db'), copy)
      // WAL 模式下数据在 -wal 里，只拷主库会得到 "no such table"（踩过）
      for (const suffix of ['-wal', '-shm']) {
        try { fs.copyFileSync(path.join(userData, `shopilot.db${suffix}`), `${copy}${suffix}`) } catch { /* 不存在就算了 */ }
      }
      const db = new DatabaseSync(copy)
      const rows = db.prepare('SELECT id, url, title FROM tabs WHERE store_id = ?').all(storeId)
      console.log(`      关店后库里 tabs 行：${JSON.stringify(rows.map(r => ({ id: String(r.id).slice(0, 8), url: String(r.url).slice(0, 60) })))}`)
      db.close()
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${copy}${suffix}`, { force: true })
    } catch (error) {
      console.log(`      读库失败：${error?.message || error}`)
    }
    await cdp.eval(`const card = document.querySelector('[data-test="store-card"]'); if (card) card.click(); return true`)
    const second = await waitForAttached(cdp, storeId)
    const restoreDebug = await cdp.eval(`
      const st = await window.shopilot.browser.state()
      const row = (st.data?.stores || []).find(s => s.storeId === ${JSON.stringify(storeId)})
      return JSON.stringify({
        tabs: (row?.tabs || []).map(t => ({ id: String(t.id).slice(0, 8), url: String(t.url).slice(0, 60), attached: t.guestAttached === true })),
        activeTabId: row?.activeTabId ? String(row.activeTabId).slice(0, 8) : null
      })
    `)
    console.log(`      关店前主进程 tab：${JSON.stringify(loaded && { url: loaded.url, tabUrl: loaded.tabUrl })}`)
    console.log(`      重开后主进程 tabs：${restoreDebug}`)
    check('关店重开后同样在 10 秒内注册上（恢复路径）', second.ms !== null, second.ms === null ? `未注册，浮层=${second.overlay || '无'}` : `${second.ms}ms`)
    check('恢复路径把上次的 URL 载回来了', String(second.snapshot.tabUrl).includes('pinduoduo'), String(second.snapshot.tabUrl).slice(0, 60))
    check('全程没有"超过 30 秒仍未就绪"的兜底文案（说明不是靠看门狗收场）', !String(second.overlay).includes('超过 30 秒'), second.overlay || '无浮层')
  } finally {
    if (cdp) cdp.close()
    killTree(child)
    await sleep(1500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本异常：', error?.message || error)
  process.exit(1)
})
