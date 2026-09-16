/**
 * M1 原子化验收运行器：
 * 1. 用独立 userData 启动 Electron（生产构建）
 * 2. 等待 CDP 就绪
 * 3. 运行 m1-e2e-store-check.js（店铺 CRUD 全链路）
 * 4. 运行隔离验证（两个店铺 session partition）
 * 5. 清理进程
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const userData = path.join(os.tmpdir(), 'shopilot-m1-test-' + Date.now())

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 结束应用进程树。Windows 上只 kill 主进程会留下渲染进程僵尸（实测残留 84MB renderer，
 * 用同一调试端口再启动时会互相干扰），所以走 taskkill /T；非 Windows 回退 SIGKILL。
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

async function waitForCDP(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url + '/json/version')
      if (res.ok) return true
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP endpoint not ready')
}

function focusAppWindow(pid) {
  if (process.platform !== 'win32' || !pid) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 3; $i++) { if ($w.AppActivate(${pid})) { break }; Start-Sleep -Milliseconds 200 }"`,
      { stdio: 'ignore', timeout: 8000 }
    )
  } catch { /* 激活失败照常继续 */ }
}

/**
 * 验收期间周期性把测试窗口保持在前台：被别的窗口遮挡时 Chromium 不合成原生视图，
 * 视口测量/截图会失真。只影响测试运行（会短暂抢焦点），SHOPILOT_NO_KEEP_FOREGROUND=1 可关闭。
 */
function keepAppForeground(pid) {
  if (process.platform !== 'win32' || !pid || process.env.SHOPILOT_NO_KEEP_FOREGROUND === '1') return null
  focusAppWindow(pid)
  const timer = setInterval(() => focusAppWindow(pid), 2500)
  timer.unref?.()
  return timer
}

/**
 * 清理占用调试端口的遗留实例：上一轮若被强杀会留下僵尸实例继续监听 9223，
 * 新实例绑不上端口，验收脚本就会**连到旧实例**（症状：卡住/状态对不上）。测试端口专用，直接清占用者。
 */
function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) {
      console.log(`端口 ${port} 被 PID ${pid} 占用（疑似上一轮遗留实例），先结束它`)
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch {}
    }
  } catch { /* 没有占用，正常 */ }
}

async function main() {
  fs.mkdirSync(userData, { recursive: true })

  console.log('=== 启动应用（独立测试 userData） ===')
  freeDebugPort(9223)
  const app = spawn(electronExe, [
    root,
    '--no-sandbox',
    '--remote-debugging-port=9223',
    '--user-data-dir=' + userData,
    // 开发机上常有其他浏览器窗口压在测试窗口上：默认的 Windows 原生遮挡计算会让被遮挡窗口
    // 停止合成（截图/视口测量随之失真）。测试环境专用，产品启动参数不变。
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows'
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1' } })

  let appLog = ''
  // 只有"收尾前就自己退出"才算异常；收尾时被我们杀掉是正常路径，无条件报 !!! 会被误读成崩溃
  let stopping = false
  app.stdout.on('data', d => { appLog += d.toString() })
  app.stderr.on('data', d => { appLog += d.toString() })
  app.on('exit', (code) => { if (!stopping) console.log('!!! 应用提前退出，code=' + code + '\n日志:\n' + appLog) })

  let keepFocus = null
  try {
    await waitForCDP('http://127.0.0.1:9223')
    console.log('CDP 就绪，运行 M1 全链路验证（原生 CDP）...')
    keepFocus = keepAppForeground(app.pid)
    await sleep(1000)

    const e2e = spawn(process.execPath, [path.join(root, 'tools', 'acceptance', 'm1-cdp-verify.js')], {
      stdio: 'inherit',
      env: { ...process.env, SHOPILOT_CDP_PORT: '9223', SHOPILOT_APP_PID: String(app.pid) }
    })
    const e2eCode = await new Promise(r => e2e.on('exit', r))

    console.log('\nE2E_EXIT=' + e2eCode)
    if (e2eCode !== 0) process.exitCode = 1
  } finally {
    if (keepFocus) clearInterval(keepFocus)
    stopping = true
    killTree(app)
    await sleep(1000)
  }
}

main().catch(err => { console.error('RUNNER_ERROR', err); try { process.exit(1) } catch {}; })
