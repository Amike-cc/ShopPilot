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

const root = __dirname
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const userData = path.join(os.tmpdir(), 'shopilot-m1-test-' + Date.now())

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

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

async function main() {
  fs.mkdirSync(userData, { recursive: true })

  console.log('=== 启动应用（独立测试 userData） ===')
  const app = spawn(electronExe, [
    root,
    '--no-sandbox',
    '--remote-debugging-port=9223',
    '--user-data-dir=' + userData
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1' } })

  let appLog = ''
  app.stdout.on('data', d => { appLog += d.toString() })
  app.stderr.on('data', d => { appLog += d.toString() })
  app.on('exit', (code) => { console.log('!!! 应用提前退出，code=' + code + '\n日志:\n' + appLog) })

  try {
    await waitForCDP('http://127.0.0.1:9223')
    console.log('CDP 就绪，运行 M1 全链路验证（原生 CDP）...')

    const e2e = spawn(process.execPath, [path.join(root, 'm1-cdp-verify.js')], {
      stdio: 'inherit',
      env: { ...process.env, SHOPILOT_CDP_PORT: '9223' }
    })
    const e2eCode = await new Promise(r => e2e.on('exit', r))

    console.log('\nE2E_EXIT=' + e2eCode)
    if (e2eCode !== 0) process.exitCode = 1
  } finally {
    try { app.kill('SIGTERM') } catch {}
    await sleep(1000)
  }
}

main().catch(err => { console.error('RUNNER_ERROR', err); try { process.exit(1) } catch {}; })
