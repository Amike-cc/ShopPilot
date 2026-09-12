/**
 * 安全能力验收运行器：会话包 / Cookie / 应用锁 / 代理巡检（端口 9226）
 * 注入对话框测试钩子（SHOPILOT_TEST_PASSWORD / AUTOCONFIRM）与 userData 路径供明文扫描。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = __dirname
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.SHOPILOT_CDP_PORT || '9226'

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

async function main() {
  console.log('=== 安全能力套件（会话包/Cookie/应用锁/代理巡检） ===')
  const userData = path.join(os.tmpdir(), 'shopilot-sec-test-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const app = spawn(electronExe, [
    root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1',
      SHOPILOT_TEST_PASSWORD: 'exp0rt-pw-123',
      SHOPILOT_TEST_AUTOCONFIRM: '1'
    }
  })
  let appLog = ''
  app.stdout.on('data', d => { appLog += d.toString() })
  app.stderr.on('data', d => { appLog += d.toString() })
  app.on('exit', code => { if (code) console.log('!!! 应用退出 code=' + code + '\n' + appLog.slice(-2500)) })

  let code = 1
  try {
    await waitForCDP()
    const v = spawn(process.execPath, [path.join(root, 'sec-cdp-verify.js')], {
      stdio: 'inherit',
      env: { ...process.env, SHOPILOT_CDP_PORT: PORT, SHOPILOT_USERDATA_DIR: userData }
    })
    code = await new Promise(r => v.on('exit', r))
    if (code !== 0) {
      const interesting = appLog.split('\n').filter(l => /\[task-runner\]|\[scheduler\]|SESSION_|APP_LOCKED|proxy|Error/i.test(l))
      if (interesting.length) console.log('--- 应用相关日志 ---\n' + interesting.slice(-30).join('\n'))
    }
  } catch (e) {
    console.error('RUNNER_FAIL', e)
  } finally {
    killTree(app)
    await sleep(1000)
  }
  console.log('\n安全套件: ' + (code === 0 ? 'PASS' : 'FAIL'))
  process.exit(code === 0 ? 0 : 1)
}

main().catch(err => { console.error('RUNNER_ERROR', err); process.exit(1) })
