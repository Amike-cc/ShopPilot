/**
 * M3 任务引擎验收运行器：
 * 启动应用（独立临时 userData + 远程调试端口 + 禁 CDP 指纹避免冲突），
 * 跑 m3-cdp-verify.js（内含本地测试站点），失败时输出任务引擎相关日志。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.SHOPILOT_CDP_PORT || '9225'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 结束应用进程树。Windows 上只 kill 主进程会留下渲染进程僵尸（实测残留 84MB renderer），
 * 所以走 taskkill /T；非 Windows 回退 SIGKILL。
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return true
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP endpoint not ready')
}

/**
 * 清理占用调试端口的遗留实例。
 * 上一轮验收若被强杀（或 finally 没跑到），会留下僵尸实例继续监听调试端口；此时新实例绑不上端口，
 * 验收脚本会**连到旧实例上**——症状是"卡住 / 状态对不上"，很难查。测试端口专用，直接清占用者。
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

/**
 * 把测试窗口拉到前台。
 * 开发机上常有其他浏览器窗口压在上面：被遮挡的窗口 Chromium 不会继续合成，
 * WebContentsView 的 capturePage 会一直返回空图（截图步骤必失败）。
 * 只影响测试运行，产品行为不变。
 */
function focusAppWindow(pid) {
  if (process.platform !== 'win32' || !pid) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 3; $i++) { if ($w.AppActivate(${pid})) { break }; Start-Sleep -Milliseconds 200 }"`,
      { stdio: 'ignore', timeout: 8000 }
    )
  } catch (e) {
    console.log('（前台激活失败，忽略：' + String(e && e.message || e).slice(0, 60) + '）')
  }
}

/**
 * 验收期间周期性地把测试窗口保持在前台。
 * 单次激活不够：开发机上随时可能有别的窗口抢回焦点，而一旦被测窗口被遮挡，
 * Chromium 就不合成 WebContentsView，截图步骤会稳定报 CAPTURE_EMPTY。
 * 只在测试运行时这么做（会短暂抢焦点），设 SHOPILOT_NO_KEEP_FOREGROUND=1 可关闭。
 */
function keepAppForeground(pid) {
  if (process.platform !== 'win32' || !pid || process.env.SHOPILOT_NO_KEEP_FOREGROUND === '1') return null
  focusAppWindow(pid)
  const timer = setInterval(() => focusAppWindow(pid), 2500)
  timer.unref?.()
  return timer
}

async function main() {
  console.log('=== M3：任务引擎套件（TaskRunner/Scheduler/门禁/UI） ===')
  const userData = path.join(os.tmpdir(), 'shopilot-m3-test-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(PORT)
  const app = spawn(electronExe, [
    root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData,
    // 开发机上常有其他浏览器窗口压在测试窗口上：默认的 Windows 原生遮挡计算会让被遮挡窗口
    // 停止合成（截图步骤就会 CAPTURE_EMPTY）。测试环境专用，产品启动参数不变。
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
  })
  let appLog = ''
  app.stdout.on('data', d => { appLog += d.toString() })
  app.stderr.on('data', d => { appLog += d.toString() })
  app.on('exit', code => { if (code) console.log('!!! 应用退出 code=' + code + '\n' + appLog.slice(-2500)) })

  let code = 1
  let keepFocus = null
  try {
    await waitForCDP()
    keepFocus = keepAppForeground(app.pid)
    await sleep(1200)
    const v = spawn(process.execPath, [path.join(root, 'tools', 'acceptance', 'm3-cdp-verify.js')], {
      stdio: 'inherit',
      env: { ...process.env, SHOPILOT_CDP_PORT: PORT, SHOPILOT_APP_PID: String(app.pid) }
    })
    code = await new Promise(r => v.on('exit', r))
    if (code !== 0) {
      const interesting = appLog.split('\n').filter(l => /\[task-runner\]|\[scheduler\]|task_|TASK_|Error/i.test(l))
      if (interesting.length) console.log('--- 应用任务引擎相关日志 ---\n' + interesting.slice(-40).join('\n'))
    }
  } catch (e) {
    console.error('RUNNER_FAIL', e)
  } finally {
    if (keepFocus) clearInterval(keepFocus)
    killTree(app)
    await sleep(1000)
  }
  console.log('\nM3 套件: ' + (code === 0 ? 'PASS' : 'FAIL'))
  process.exit(code === 0 ? 0 : 1)
}

main().catch(err => { console.error('RUNNER_ERROR', err); process.exit(1) })
