/**
 * M2 验收运行器（两阶段）：
 *  阶段1：外部 CDP 驱动 → m2-cdp-verify.js（代理 / 407 注入 / 备份 / 字段落库）
 *         （SHOPILOT_DISABLE_CDP_FP=1 避免与外部调试会话互斥）
 *  阶段2：SHOPILOT_FP_AUTOTEST=1 无外部端口进程内自检 → 时区 CDP + 注入实测值回填
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = '9224'

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

async function waitForCDP(timeoutMs = 25000) {
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

async function stage1() {
  const userData = path.join(os.tmpdir(), 'shopilot-m2-test-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  console.log('=== 阶段1：M2 主套件（代理/407/备份） ===')
  const app = spawn(electronExe, [
    root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
  })
  let appLog = ''
  app.stdout.on('data', d => { appLog += d.toString() })
  app.stderr.on('data', d => { appLog += d.toString() })
  app.on('exit', code => { if (code) console.log('!!! 应用退出 code=' + code + '\n' + appLog.slice(-2000)) })

  let code = 1
  try {
    await waitForCDP()
    const v = spawn(process.execPath, [path.join(root, 'tools', 'acceptance', 'm2-cdp-verify.js')], {
      stdio: 'inherit',
      env: { ...process.env, SHOPILOT_CDP_PORT: PORT }
    })
    code = await new Promise(r => v.on('exit', r))
    if (code !== 0) {
      const interesting = appLog.split('\n').filter(l => /\[login\]|setProxy|proxy login|PROXIED|407|proxy/i.test(l))
      if (interesting.length) console.log('--- 应用代理相关日志 ---\n' + interesting.slice(-30).join('\n'))
    }
  } finally {
    killTree(app)
    await sleep(1000)
  }
  return code === 0
}

async function stage2() {
  console.log('\n=== 阶段2：环境指纹进程内自检（含时区 CDP） ===')
  const userData = path.join(os.tmpdir(), 'shopilot-m2-fp-' + Date.now())
  const resultPath = path.join(os.tmpdir(), `shopilot-fp-result-${Date.now()}.json`)
  fs.mkdirSync(userData, { recursive: true })
  const app = spawn(electronExe, [root, '--no-sandbox', '--user-data-dir=' + userData], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', SHOPILOT_FP_AUTOTEST: '1', SHOPILOT_FP_RESULT: resultPath }
  })
  let log = ''
  app.stdout.on('data', d => { log += d.toString() })
  app.stderr.on('data', d => { log += d.toString() })

  const t0 = Date.now()
  while (!fs.existsSync(resultPath) && Date.now() - t0 < 40000) {
    await sleep(500)
    if (app.exitCode !== null && !fs.existsSync(resultPath) && Date.now() - t0 > 5000) break
  }
  try { killTree(app) } catch {}

  if (!fs.existsSync(resultPath)) {
    console.log('FAIL - 指纹自检无结果文件\n日志尾部:\n' + log.slice(-2000))
    return false
  }
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  if (report.error) { console.log('FAIL - 自检异常: ' + report.error); return false }
  const items = report.items || []
  const byField = Object.fromEntries(items.map(i => [i.field, i]))
  console.log(items.map(i => `  ${i.field}: ${i.state} (期望=${i.expected} 实际=${i.actual})`).join('\n'))
  const required = ['userAgent', 'language', 'timezone', 'screen', 'hardwareConcurrency']
  let allOk = true
  for (const f of required) {
    const it = byField[f]
    const okf = !!it && it.state === 'verified'
    console.log(`${okf ? 'PASS' : 'FAIL'} - 字段实测已验证: ${f}` + (it ? '' : '（缺失）'))
    if (!okf) allOk = false
  }
  return allOk
}

async function main() {
  const only = process.argv[2]
  const s1 = only === 'stage2' ? true : await stage1()
  const s2 = only === 'stage1' ? true : await stage2()
  console.log('\n===== M2 汇总 =====')
  console.log('阶段1（代理/407/备份）: ' + (s1 ? 'PASS' : 'FAIL'))
  console.log('阶段2（指纹实测注入）  : ' + (s2 ? 'PASS' : 'FAIL'))
  if (s1 && s2) console.log('ALL_M2_ACCEPTANCE_PASSED')
  else process.exitCode = 1
}

main().catch(err => { console.error('RUNNER_ERROR', err); process.exit(1) })
