/**
 * update-online-drill.js — 线上更新真实演练（GitHub Releases 全链路，§21）
 *
 * 与 update-runner（本地 feed 验收）互补：本演练走**真实公网 GitHub feed**，
 * 用旧版打包应用（默认 release-drill-backup/win-unpacked = 0.1.0）真实完成：
 *   stable 通道隔离（prerelease 不可见）→ 切 beta 通道发现新版
 *   → 从 GitHub 真实下载（85MB）→ SHA-512 校验 → pending 落盘 → 审计落库
 *   → 退出应用 → /S 静默安装下载产物（与产品内"重启并安装"同一 NSIS 安装包；
 *     产品按钮走 quitAndInstall(false,true) 带交互向导，无人值守演练用 /S 替代）
 *   → 启动安装版验证 currentVersion 已升级 → beta 通道复查 not-available
 *   → 静默卸载、清理临时目录
 *
 * 前置：GitHub 已发布更高版本 Release（prerelease 亦可），本地 release/beta.yml|latest.yml 为同版本构建产物。
 * 用法：node update-online-drill.js [旧版win-unpacked目录] [新版本号] [旧版本号]
 *       默认：release-drill-backup/win-unpacked  0.1.1-beta.1  0.1.0
 * CDP：旧版 9247 / 安装版 9248；日志：update-online-drill.log
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync, execSync } = require('child_process')

const ROOT = __dirname
const OLD_DIR = process.argv[2] || path.join(ROOT, 'release-drill-backup', 'win-unpacked')
const NEW_VERSION = process.argv[3] || '0.1.1-beta.1'
const OLD_VERSION = process.argv[4] || '0.1.0'
const PORT_OLD = 9247
const PORT_INSTALLED = 9248

const items = []
function record(name, ok, detail) {
  items.push({ name, ok: !!ok, detail: detail === undefined ? null : detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
}
function report(passed) {
  const out = { suite: 'update-online-drill', passed, total: items.length, ok: items.filter(i => i.ok).length, items, finishedAt: new Date().toISOString() }
  try { fs.writeFileSync(path.join(ROOT, 'update-online-drill.log'), JSON.stringify(out, null, 2)) } catch { /* ignore */ }
  console.log(JSON.stringify({ passed, total: out.total, ok: out.ok }))
  if (passed) console.log('DRILL_PASSED')
}
function fail(msg) { console.error('DRILL_FAILED:', msg); report(false); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data); const p = this.pending.get(m.id)
      if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
    }
  }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const i = ++this.id
      const timer = setTimeout(() => { this.pending.delete(i); rej(new Error(`CDP timeout ${method}`)) }, timeoutMs)
      this.pending.set(i, { res, rej, timer })
      this.ws.send(JSON.stringify({ id: i, method, params }))
    })
  }
  async ev(expr, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval exception')
    return r.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}
async function attachApp(port, retries = 40) {
  let lastErr = null
  for (let i = 0; i < retries; i++) {
    try {
      const ts = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = ts.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
      if (!page) throw new Error('no page target yet')
      const c = new Cdp(page.webSocketDebuggerUrl)
      await c.ready
      const ok = await c.ev(`
        for (let i = 0; i < 60; i++) {
          if (window.shopilot && document.querySelector('[data-test="update-open-btn"]')) return true
          await new Promise(r => setTimeout(r, 500))
        }
        return false`, 40000)
      if (!ok) { c.close(); throw new Error('update-open-btn not ready') }
      return c
    } catch (e) { lastErr = e; await sleep(1000) }
  }
  throw new Error('attach failed: ' + (lastErr && lastErr.message))
}

let child = null
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
function spawnApp(exe, port, userDataDir) {
  child = spawn(exe, [`--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${userDataDir}`], { stdio: 'ignore', detached: true })
  child.unref()
  return child
}
function killApp() { if (child && child.pid) { killTree(child.pid); child = null } }

async function pollStatus(c, predicate, timeoutMs, label) {
  const t0 = Date.now(); let last = null; let lastPct = -1
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await c.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : { error: r.error }`)
      if (last && typeof last.percent === 'number' && Math.floor(last.percent / 10) > Math.floor(lastPct / 10)) { lastPct = last.percent; console.log(`[download] ${last.percent}%`) }
      if (predicate(last)) return last
    } catch (e) { last = { evalError: String(e.message || e) } }
    await sleep(2000)
  }
  throw new Error(`poll timeout (${label}): last=${JSON.stringify(last)}`)
}

function pendingDir() {
  const la = process.env.LOCALAPPDATA || ''
  for (const name of ['shopilot-updater', 'ShopPilot-updater']) {
    const dir = path.join(la, name, 'pending')
    if (fs.existsSync(dir)) return dir
  }
  return path.join(la, 'shopilot-updater', 'pending')
}

async function main() {
  // 看门狗：35 分钟明确失败（85MB 公网下载留足余量），绝不挂死
  const watchdog = setTimeout(() => fail('watchdog 35min timeout'), 35 * 60 * 1000)

  const oldExe = path.join(OLD_DIR, 'ShopPilot.exe')
  if (!fs.existsSync(oldExe)) fail(`旧版应用不存在: ${oldExe}`)
  // 期望尺寸：本地同版本构建的通道 yml（与已发布资产同源）
  const ymlName = NEW_VERSION.includes('-') ? `${NEW_VERSION.split('-')[1].split('.')[0]}.yml` : 'latest.yml'
  const ymlPath = path.join(ROOT, 'release', ymlName)
  if (!fs.existsSync(ymlPath)) fail(`缺少 ${ymlPath}`)
  const expectSize = Number(/size:\s*(\d+)/.exec(fs.readFileSync(ymlPath, 'utf8'))[1])
  // 清掉可能的同名残留，证明本次是全新下载
  const pend = pendingDir()
  try { fs.rmSync(path.join(pend, `ShopPilot-Setup-${NEW_VERSION}.exe`), { force: true }) } catch { /* ignore */ }

  const udOld = fs.mkdtempSync(path.join(os.tmpdir(), 'shopilot-drill-old-'))
  const udNew = fs.mkdtempSync(path.join(os.tmpdir(), 'shopilot-drill-new-'))
  const installDir = path.join(os.tmpdir(), `shopilot-drill-install-${Date.now()}`)
  let c = null
  try {
    // ---------- 阶段1：旧版应用，真实 GitHub feed ----------
    spawnApp(oldExe, PORT_OLD, udOld)
    c = await attachApp(PORT_OLD)
    console.log('[cdp] 旧版应用就绪')

    const s0 = await c.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : { ipcError: r.error }`)
    record('旧版状态如实（0.1.0 / github feed / stable）', s0 && s0.currentVersion === OLD_VERSION && s0.feedSource === 'github' && s0.channel === 'stable', s0 && { v: s0.currentVersion, feed: s0.feedSource, ch: s0.channel })

    // stable 通道看不到 prerelease —— 通道隔离证明
    const sStable = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`, 60000)
    record('stable 通道检查 → not-available（prerelease 隔离）', sStable && sStable.state === 'not-available', sStable && { state: sStable.state, version: sStable.version, error: sStable.error })

    // 切 beta 通道 → 真实 GitHub 解析 prerelease
    await c.ev(`await window.shopilot.settings.set('update.channel', 'beta'); return true`)
    const sBeta = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`, 60000)
    record(`beta 通道发现 ${NEW_VERSION}（真实 GitHub feed）`, sBeta && sBeta.state === 'available' && sBeta.version === NEW_VERSION, sBeta && { state: sBeta.state, version: sBeta.version, error: sBeta.error })

    // ---------- 阶段2：真实公网下载 + 校验 ----------
    const t0 = Date.now()
    await c.ev(`window.shopilot.update.download(); return true`)
    const sDl = await pollStatus(c, s => s && (s.state === 'downloaded' || s.state === 'error'), 25 * 60 * 1000, 'github download')
    record('GitHub 真实下载完成且 SHA-512 校验通过', sDl.state === 'downloaded' && sDl.percent === 100, { state: sDl.state, percent: sDl.percent, version: sDl.version, seconds: Math.round((Date.now() - t0) / 1000), error: sDl.error })
    if (sDl.state !== 'downloaded') fail('下载未完成，后续安装无法演练（错误已如实记录）')

    const pendFile = path.join(pend, `ShopPilot-Setup-${NEW_VERSION}.exe`)
    const pendOk = fs.existsSync(pendFile) && fs.statSync(pendFile).size === expectSize
    record('pending 缓存落盘且尺寸与 beta.yml 一致', pendOk, pendOk ? { file: path.basename(pendFile), size: fs.statSync(pendFile).size } : { exists: fs.existsSync(pendFile), expectSize })

    const uiBtn = await c.ev(`
      document.querySelector('[data-test="update-open-btn"]').click()
      await new Promise(r => setTimeout(r, 500))
      return !!document.querySelector('[data-test="update-install-btn"]')`)
    record('打开对话框后出现"重启并安装"按钮（演练不点击，避免交互式向导）', uiBtn === true, { installBtn: uiBtn })

    const a1 = await c.ev(`const r = await window.shopilot.audit.query({ filter: { action: 'update.check' } }); return r.ok ? r.data : []`)
    record('审计含 update.check success', Array.isArray(a1) && a1.some(a => a.result === 'success'), { rows: Array.isArray(a1) ? a1.length : -1 })
    const a2 = await c.ev(`const r = await window.shopilot.audit.query({ filter: { action: 'update.download' } }); return r.ok ? r.data : []`)
    record('审计含 update.download success', Array.isArray(a2) && a2.some(a => a.result === 'success'), { rows: Array.isArray(a2) ? a2.length : -1 })

    // ---------- 阶段3：静默安装下载产物并验证升级 ----------
    c.close(); c = null
    killApp()
    await sleep(3000)
    const inst = spawnSync(pendFile, ['/S', `/D=${installDir}`], { stdio: 'ignore', timeout: 5 * 60 * 1000 })
    let installedExe = path.join(installDir, 'ShopPilot.exe')
    for (let i = 0; i < 60 && !fs.existsSync(installedExe); i++) await sleep(1000)
    record('下载产物 /S 静默安装成功', inst.status === 0 && fs.existsSync(installedExe), { exit: inst.status, exe: fs.existsSync(installedExe) })
    if (!fs.existsSync(installedExe)) fail('安装失败，无法验证升级')

    spawnApp(installedExe, PORT_INSTALLED, udNew)
    const c2 = await attachApp(PORT_INSTALLED)
    const sNew = await c2.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : { ipcError: r.error }`)
    record(`安装版 currentVersion === ${NEW_VERSION}（真实升级成功）`, sNew && sNew.currentVersion === NEW_VERSION, sNew && { v: sNew.currentVersion })
    await c2.ev(`await window.shopilot.settings.set('update.channel', 'beta'); return true`)
    const sRe = await c2.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`, 60000)
    record('升级后 beta 通道复查 → not-available（版本闭环）', sRe && sRe.state === 'not-available', sRe && { state: sRe.state, version: sRe.version })
    c2.close()
    killApp()
    await sleep(2000)

    // ---------- 阶段4：静默卸载清理 ----------
    // NSIS 卸载器会自复制到 %TEMP% 后立即返回原进程，真实清理是异步的：
    // 先兜底杀掉任何残留 ShopPilot 子进程，再轮询目录消失（120s）
    try { execSync('taskkill /IM ShopPilot.exe /T /F', { stdio: 'ignore' }) } catch { /* 无残留进程时忽略 */ }
    await sleep(1500)
    const uninst = path.join(installDir, 'Uninstall ShopPilot.exe')
    if (fs.existsSync(uninst)) {
      spawnSync(uninst, ['/S'], { stdio: 'ignore', timeout: 2 * 60 * 1000 })
      for (let i = 0; i < 120 && fs.existsSync(installDir); i++) await sleep(1000)
    }
    let leftovers = []
    if (fs.existsSync(installDir)) {
      try { leftovers = fs.readdirSync(installDir, { recursive: true }) } catch { /* ignore */ }
      // NSIS 偶发留下空壳目录（Defender 扫描/句柄延迟释放）：文件全清即卸载成功，空壳顺手移除并如实标注
      if (leftovers.length === 0) { try { fs.rmdirSync(installDir) } catch { /* ignore */ } }
    }
    const gone = !fs.existsSync(installDir)
    record('演练后静默卸载清理干净（无文件残留）', gone || leftovers.length === 0, { installDirGone: gone, fileLeftovers: leftovers.length, sample: leftovers.slice(0, 10) })

    clearTimeout(watchdog)
    const passed = items.every(i => i.ok)
    report(passed)
    if (!passed) process.exitCode = 1
  } catch (e) {
    record('运行异常', false, String(e && e.stack || e))
    clearTimeout(watchdog)
    report(false)
    process.exitCode = 1
  } finally {
    if (c) c.close()
    killApp()
    await sleep(1500)
    for (const d of [udOld, udNew, installDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
    try { fs.rmSync(path.join(pend, `ShopPilot-Setup-${NEW_VERSION}.exe`), { force: true }) } catch { /* ignore */ }
  }
}
main()
