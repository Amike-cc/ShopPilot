/**
 * update-runner.js — 软件更新链路验收（§21）
 *
 * 用本地 HTTP generic feed（latest.yml/beta.yml + 真实安装包副本，版本伪装 9.9.9）
 * 驱动 release/win-unpacked 里的真实打包应用：
 *   检查更新 → 发现新版本 → 下载（electron-updater SHA-512 校验）→ downloaded
 *   → 审计落库 → 已是最新 → stable/beta 双通道 → feed 故障如实报错 → 重启自动检查
 * 不执行 quitAndInstall（会真装 9.9.9），安装行为由 m4-runner 的 NSIS 阶段覆盖。
 *
 * 前置：先跑过 pnpm dist（需要 release/win-unpacked 与 release/ShopPilot-Setup-0.1.0.exe）。
 * 用法：node update-runner.js    （CDP 9241 / feed 9245，独立临时 userData）
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execSync } = require('child_process')

const ROOT = __dirname
const CDP_PORT = 9241
const FEED_PORT = 9245
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/`
const NEW_VERSION = '9.9.9'
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const items = []
function record(name, ok, detail) {
  items.push({ name, ok: !!ok, detail: detail === undefined ? null : detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
}
function fail(msg) { console.error('UPDATE_RUNNER_FAILED:', msg); report(false); process.exit(1) }
function report(passed) {
  const out = { suite: 'update-runner', passed, total: items.length, ok: items.filter(i => i.ok).length, items, finishedAt: new Date().toISOString() }
  try { fs.writeFileSync(path.join(ROOT, 'update-run1.log'), JSON.stringify(out, null, 2)) } catch { /* ignore */ }
  console.log(JSON.stringify({ passed, total: out.total, ok: out.ok }))
  if (passed) console.log('UPDATE_RUNNER_PASSED')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- feed 服务器 ----------
let feedDir = ''
let failMode = false
function ymlFor(version, exeName, sha512, size) {
  return `version: ${version}\nfiles:\n  - url: ${exeName}\n    sha512: ${sha512}\n    size: ${size}\npath: ${exeName}\nsha512: ${sha512}\nreleaseDate: '2026-09-12T07:00:00.000Z'\n`
}
function startFeedServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (failMode) { res.writeHead(500); res.end('feed down'); return }
      const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'latest.yml'
      const file = path.join(feedDir, path.basename(name))
      if (!file.startsWith(feedDir) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
      const isYml = file.endsWith('.yml')
      res.writeHead(200, { 'Content-Type': isYml ? 'text/yaml' : 'application/octet-stream', 'Content-Length': fs.statSync(file).size })
      if (req.method === 'HEAD') { res.end(); return }
      fs.createReadStream(file).pipe(res)
    })
    server.on('error', reject)
    server.listen(FEED_PORT, '127.0.0.1', () => resolve(server))
  })
}

// ---------- CDP ----------
async function cdpTargets() { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) }
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
async function attachApp(retries = 30) {
  let lastErr = null
  for (let i = 0; i < retries; i++) {
    try {
      const ts = await cdpTargets()
      const page = ts.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
      if (!page) throw new Error('no page target yet')
      const c = new Cdp(page.webSocketDebuggerUrl)
      await c.ready
      // 等 UI 真正就绪（更新入口按钮出现），而非仅 readyState
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

// ---------- 应用进程 ----------
let appChild = null
let userDataDir = ''
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
function spawnApp() {
  const exe = path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
  if (!fs.existsSync(exe)) fail('release/win-unpacked/ShopPilot.exe 不存在，请先 pnpm dist')
  appChild = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', `--user-data-dir=${userDataDir}`], {
    env: { ...process.env, SHOPPILOT_UPDATE_FEED: FEED_URL },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appChild.stdout.on('data', () => { /* drain */ })
  appChild.stderr.on('data', () => { /* drain */ })
  appChild.on('exit', (code) => { console.log(`[app] exited code=${code}`) })
}
function killApp() { if (appChild && appChild.pid) { killTree(appChild.pid); appChild = null } }

async function pollStatus(c, predicate, timeoutMs, label) {
  const t0 = Date.now(); let last = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await c.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : { error: r.error }`)
      if (predicate(last)) return last
    } catch (e) { last = { evalError: String(e.message || e) } }
    await sleep(1000)
  }
  throw new Error(`poll timeout (${label}): last=${JSON.stringify(last)}`)
}

// ---------- 主流程 ----------
async function main() {
  // 看门狗：8 分钟明确失败，绝不挂死（M4 缺陷 #13 教训）
  const watchdog = setTimeout(() => fail('watchdog 8min timeout'), 8 * 60 * 1000)

  const setupExe = path.join(ROOT, 'release', `ShopPilot-Setup-${APP_VERSION}.exe`)
  if (!fs.existsSync(setupExe)) fail(`${setupExe} 不存在，请先 pnpm dist`)

  feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopilot-feed-'))
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopilot-update-userdata-'))
  const fakeExeName = `ShopPilot-Setup-${NEW_VERSION}.exe`
  fs.copyFileSync(setupExe, path.join(feedDir, fakeExeName))
  const buf = fs.readFileSync(path.join(feedDir, fakeExeName))
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
  const size = buf.length
  fs.writeFileSync(path.join(feedDir, 'latest.yml'), ymlFor(NEW_VERSION, fakeExeName, sha512, size))
  fs.writeFileSync(path.join(feedDir, 'beta.yml'), ymlFor(NEW_VERSION, fakeExeName, sha512, size))

  const server = await startFeedServer()
  console.log(`[feed] serving ${feedDir} at ${FEED_URL} (fake ${NEW_VERSION}, sha512 ok)`)

  let c = null
  try {
    spawnApp()
    c = await attachApp()
    console.log('[cdp] attached, UI ready')

    // 1. 初始状态
    const s0 = await c.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : { ipcError: r.error }`)
    record('初始 update:status 可用', s0 && !s0.ipcError && s0.currentVersion === APP_VERSION, s0 && { state: s0.state, currentVersion: s0.currentVersion, feedSource: s0.feedSource, channel: s0.channel })
    record('feed 覆盖生效（env-override）', s0 && s0.feedSource === 'env-override', s0 && s0.feedSource)

    // 2. UI 对话框可打开、通道默认 stable
    const ui = await c.ev(`
      document.querySelector('[data-test="update-open-btn"]').click()
      await new Promise(r => setTimeout(r, 400))
      const dlg = document.querySelector('[data-test="update-dialog"]')
      return { open: !!dlg, channel: document.querySelector('[data-test="update-channel"]')?.value, autocheck: document.querySelector('[data-test="update-autocheck"]')?.checked, message: document.querySelector('[data-test="update-message"]')?.textContent?.trim() }`)
    record('更新对话框可打开且含通道选择', ui.open && ui.channel === 'stable' && ui.autocheck === false, ui)

    // 3. 未下载时点击"重启并安装"被守卫拒绝
    const guard = await c.ev(`const r = await window.shopilot.update.install(); return r.ok ? r.data : { ipcError: r.error }`)
    record('未下载完成时 install 被拒绝', guard && guard.state === 'error' && String(guard.error || '').includes('尚未下载完成'), guard && { state: guard.state, error: guard.error })

    // 4. 检查更新 → 发现 9.9.9
    const s1 = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`)
    record('检查发现新版本 9.9.9', s1 && s1.state === 'available' && s1.version === NEW_VERSION, s1 && { state: s1.state, version: s1.version })
    const msgAvail = await c.ev(`await new Promise(r=>setTimeout(r,300)); return document.querySelector('[data-test="update-message"]')?.textContent?.trim()`)
    record('UI 展示"发现新版本 v9.9.9"', String(msgAvail || '').includes('发现新版本 v9.9.9'), msgAvail)

    // 5. 下载 → SHA-512 校验 → downloaded（80MB 本地回环，180s 上限）
    await c.ev(`window.shopilot.update.download(); return true`)
    const s2 = await pollStatus(c, s => s && (s.state === 'downloaded' || s.state === 'error'), 180000, 'download')
    record('下载完成且通过校验（state=downloaded, percent=100）', s2.state === 'downloaded' && s2.percent === 100, { state: s2.state, percent: s2.percent, version: s2.version, error: s2.error })

    // 6. 下载缓存文件真实落盘（*-updater/pending）
    const localAppData = process.env.LOCALAPPDATA || ''
    let pendingFile = null
    for (const name of ['shopilot-updater', 'ShopPilot-updater']) {
      const dir = path.join(localAppData, name, 'pending')
      if (fs.existsSync(dir)) {
        const f = fs.readdirSync(dir).find(x => x.toLowerCase().endsWith('.exe'))
        if (f) { pendingFile = path.join(dir, f); break }
      }
    }
    record('更新包落盘 pending 缓存', !!pendingFile && fs.statSync(pendingFile).size === size, pendingFile && { file: path.basename(pendingFile), size: fs.statSync(pendingFile).size })

    // 7. downloaded 状态下出现"重启并安装"按钮（不点击——会真装 9.9.9）
    const uiBtn = await c.ev(`await new Promise(r=>setTimeout(r,300)); return !!document.querySelector('[data-test="update-install-btn"]')`)
    record('downloaded 后 UI 出现"重启并安装"按钮', uiBtn === true, { installBtn: uiBtn })

    // 8/9. 审计：update.check / update.download 各至少一条 success
    const auditCheck = await c.ev(`const r = await window.shopilot.audit.query({ filter: { action: 'update.check' } }); return r.ok ? r.data : []`)
    record('审计含 update.check success', Array.isArray(auditCheck) && auditCheck.some(a => a.result === 'success'), { rows: Array.isArray(auditCheck) ? auditCheck.length : -1 })
    const auditDl = await c.ev(`const r = await window.shopilot.audit.query({ filter: { action: 'update.download' } }); return r.ok ? r.data : []`)
    record('审计含 update.download success', Array.isArray(auditDl) && auditDl.some(a => a.result === 'success'), { rows: Array.isArray(auditDl) ? auditDl.length : -1 })

    // 10. feed 改为当前版本 → not-available
    fs.writeFileSync(path.join(feedDir, 'latest.yml'), ymlFor(APP_VERSION, fakeExeName, sha512, size))
    const s3 = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`)
    record('同版本时如实报告"已是最新"', s3 && s3.state === 'not-available', s3 && { state: s3.state })

    // 11. 切到 beta 通道（beta.yml=9.9.9）→ 状态回显 channel=beta 且能发现更新
    await c.ev(`await window.shopilot.settings.set('update.channel', 'beta'); return true`)
    const sCh = await c.ev(`const r = await window.shopilot.update.status(); return r.ok ? r.data : {}`)
    const s4 = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`)
    record('beta 通道生效（status.channel=beta 且发现 9.9.9）', sCh.channel === 'beta' && s4 && s4.state === 'available' && s4.version === NEW_VERSION, { channel: sCh.channel, state: s4 && s4.state, version: s4 && s4.version })
    await c.ev(`await window.shopilot.settings.set('update.channel', 'stable'); return true`)

    // 12. feed 故障（500）→ state=error 且带真实错误信息 + 审计 failure
    failMode = true
    const s5 = await c.ev(`const r = await window.shopilot.update.check(); return r.ok ? r.data : { ipcError: r.error }`)
    record('feed 故障时如实报错（不静默）', s5 && s5.state === 'error' && String(s5.error || '').length > 0, s5 && { state: s5.state, error: String(s5.error || '').slice(0, 160) })
    failMode = false
    const auditFail = await c.ev(`const r = await window.shopilot.audit.query({ filter: { action: 'update.check' } }); return r.ok ? r.data : []`)
    record('审计含 update.check failure（故障留痕）', Array.isArray(auditFail) && auditFail.some(a => a.result === 'failure'), { rows: Array.isArray(auditFail) ? auditFail.length : -1 })

    // 13. autoCheck 开启 → 重启应用 → 启动后自动检查（8s 排程 + 网络，45s 上限）
    await c.ev(`await window.shopilot.settings.set('update.autoCheck', true); return true`)
    fs.writeFileSync(path.join(feedDir, 'latest.yml'), ymlFor(NEW_VERSION, fakeExeName, sha512, size))
    c.close(); c = null
    killApp()
    await sleep(3000)
    spawnApp()
    c = await attachApp()
    const sAuto = await pollStatus(c, s => s && s.state !== 'idle', 45000, 'autoCheck').catch(e => ({ state: 'idle', timeout: String(e.message || e) }))
    record('重启后自动检查更新（autoCheck=true）', sAuto && sAuto.state !== 'idle', { state: sAuto && sAuto.state, version: sAuto && sAuto.version })
    await c.ev(`await window.shopilot.settings.set('update.autoCheck', false); return true`)

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
    server.close()
    await sleep(1500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(feedDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
main()
