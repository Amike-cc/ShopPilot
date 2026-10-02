/** Run Agent CDP acceptance in a fresh throwaway Electron profile and remove that profile afterward. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const PORT = Number(process.env.SHOPILOT_AGENT_CDP_PORT || 9226)
const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForCDP(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (response.ok) return }
    catch {}
    await sleep(300)
  }
  throw new Error('Agent CDP endpoint not ready')
}

function focusApp(pid) {
  if (process.platform !== 'win32' || !pid) return
  try { execSync(`powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $w.AppActivate(${pid}) | Out-Null"`, { stdio: 'ignore', timeout: 5000 }) }
  catch { /* Focus is only needed for a best-effort visible compositor screenshot. */ }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {}
}

async function main() {
  try {
    const occupied = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false)
    if (occupied) throw new Error(`专用 Agent CDP 端口 ${PORT} 已有服务，停止以避免连接或结束其他进程`)
    const userData = path.join(os.tmpdir(), `shopilot-agent-cdp-${Date.now()}`)
    // 隔离应用数据：verify 会写 app_settings、AI Key、临时店铺，绝不能碰真实用户目录。
    const fixtureAppData = path.join(userData, 'appdata')
    fs.mkdirSync(fixtureAppData, { recursive: true })
    const child = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
    })
    let logs = ''
    child.stdout.on('data', chunk => { logs += chunk.toString() })
    child.stderr.on('data', chunk => { logs += chunk.toString() })
    let code = 1
    try {
      await waitForCDP()
      focusApp(child.pid)
      const verifier = spawn(process.execPath, [path.join(ROOT, 'tools', 'acceptance', 'agent-cdp-verify.js')], {
        stdio: 'inherit', env: { ...process.env, SHOPILOT_CDP_PORT: String(PORT), SHOPPILOT_TEST_AUTOCONFIRM: '1' }
      })
      code = await new Promise(resolve => verifier.on('exit', resolve))
      if (logs.includes('temporary-agent-cdp-key-123456')) {
        console.error('FAIL - Main 进程日志包含测试 AI Key 明文')
        code = 1
      } else if (code === 0) console.log('PASS - 主进程日志中未发现测试 AI Key 明文')
    } finally {
      killTree(child)
      await sleep(600)
      const tempRoot = path.resolve(os.tmpdir())
      const resolved = path.resolve(userData)
      if (resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('shopilot-agent-cdp-')) {
        try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (error) { console.warn('临时验收数据清理失败:', String(error).slice(0, 120)) }
      }
    }
    if (code !== 0 && logs) console.log('--- Electron log tail ---\n' + logs.slice(-2500))
    console.log(`Agent CDP runner: ${code === 0 ? 'PASS' : 'FAIL'}`)
    process.exit(code === 0 ? 0 : 1)
  } catch (error) {
    console.error('AGENT_CDP_RUNNER_FAIL', error?.stack || error)
    process.exit(1)
  }
}

main()
