/* Isolated NSIS downgrade/rollback rehearsal using the previous local installer. */
const { spawn, spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const CURRENT_SETUP = path.join(ROOT, 'release', 'ShopPilot-Setup-0.4.47.exe')
const PREVIOUS_SETUP = path.join(ROOT, 'release', 'ShopPilot-Setup-0.4.46.exe')
const PORT = Number(process.env.SHOPPILOT_ROLLBACK_PORT || 9252)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
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
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function waitFor(fn, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await sleep(500)
  }
  throw new Error('timeout waiting for rollback condition')
}

function killStray() {
  try { execFileSync('taskkill', ['/IM', 'ShopPilot.exe', '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

function productVersion(exe) {
  const escaped = exe.replace(/'/g, "''")
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim()
}

async function waitForStableFile(file) {
  await waitFor(() => fs.existsSync(file))
  let previous = ''
  let stable = 0
  while (stable < 4) {
    const stat = fs.statSync(file)
    const signature = `${stat.size}:${stat.mtimeMs}`
    if (signature === previous) stable++
    else stable = 0
    previous = signature
    await sleep(500)
  }
}

async function install(setup, installDir) {
  const child = spawn(setup, ['/S', `/D=${installDir}`], { detached: true, stdio: 'ignore' })
  child.unref()
  const exe = path.join(installDir, 'ShopPilot.exe')
  await waitForStableFile(exe)
  await sleep(1500)
  killStray()
  return exe
}

async function launch(exe, userData, port) {
  const appData = path.join(userData, 'appdata')
  const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
    cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, SHOPPILOT_DISABLE_CDP_FP: '1' }
  })
  await waitFor(async () => fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.ok).catch(() => false), 30000)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
  if (!target) throw new Error('rollback app renderer target missing')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval('return !!window.shopilot')
  return { child, cdp }
}

async function stop(context) {
  context?.cdp?.close()
  if (context?.child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(context.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  await sleep(1200)
  killStray()
}

async function uninstall(installDir) {
  const uninstaller = path.join(installDir, 'Uninstall ShopPilot.exe')
  if (!fs.existsSync(uninstaller)) return false
  const child = spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' })
  child.unref()
  await waitFor(() => {
    const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Un_A.exe'], { encoding: 'utf8' })
    const tasks2 = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Au_.exe'], { encoding: 'utf8' })
    return !fs.existsSync(path.join(installDir, 'ShopPilot.exe')) && !/Un_A\.exe|Au_\.exe/i.test(`${tasks.stdout || ''}\n${tasks2.stdout || ''}`)
  }, 90000)
  await sleep(2500)
  // The directory is a disposable rehearsal target. Removing it after the
  // NSIS self-copy exits prevents the next install from racing delayed deletes.
  try { fs.rmSync(installDir, { recursive: true, force: true }) } catch {}
  return !fs.existsSync(path.join(installDir, 'ShopPilot.exe'))
}

async function main() {
  const report = { startedAt: new Date().toISOString(), status: 'failed', checks: [], note: 'Temporary directory only; previous local installer 0.4.46 and current 0.4.47. No customer data or real store.' }
  const check = (name, passed, detail = '') => {
    report.checks.push({ name, passed: !!passed, detail: String(detail).slice(0, 300) })
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  const tempRoot = path.join(os.tmpdir(), `shopilot-rollback-${Date.now()}`)
  const installDir = path.join(tempRoot, 'installed')
  const userData = path.join(tempRoot, 'userdata')
  let context
  try {
    if (!fs.existsSync(CURRENT_SETUP) || !fs.existsSync(PREVIOUS_SETUP)) throw new Error('current or previous installer missing')
    fs.mkdirSync(tempRoot, { recursive: true })
    const currentExe = await install(CURRENT_SETUP, installDir)
    check('0.4.47 installs into an isolated directory', fs.existsSync(currentExe), productVersion(currentExe))
    check('current installer binary reports version 0.4.47', productVersion(currentExe).startsWith('0.4.47'))
    context = await launch(currentExe, userData, PORT)
    const created = await context.cdp.eval(`return await window.shopilot.store.create({name:'rollback-fixture',platform:'本地回滚夹具',adminUrl:'http://127.0.0.1:1/'})`)
    check('current installed build writes a temporary fixture store', created?.ok === true)
    await stop(context); context = null
    const removedCurrent = await uninstall(installDir)
    check('rollback rehearsal stops and removes current build before downgrade', removedCurrent && !fs.existsSync(currentExe))

    const previousExe = await install(PREVIOUS_SETUP, installDir)
    const previousVersion = productVersion(previousExe)
    check('previous 0.4.46 installer replaces the current binary', previousVersion.startsWith('0.4.46'), previousVersion)
    context = await launch(previousExe, userData, PORT)
    const previousStores = await context.cdp.eval('return await window.shopilot.store.list()')
    check('previous build starts after rollback and preserves fixture store', previousStores?.ok === true && (previousStores.data || []).some(store => store.name === 'rollback-fixture'))
    await stop(context); context = null
    const removedPrevious = await uninstall(installDir)
    check('rollback rehearsal removes previous build before restoring current', removedPrevious && !fs.existsSync(previousExe))

    const restoredExe = await install(CURRENT_SETUP, installDir)
    check('current 0.4.47 installer can be restored after rollback', productVersion(restoredExe).startsWith('0.4.47'), productVersion(restoredExe))
    context = await launch(restoredExe, userData, PORT)
    const restoredStores = await context.cdp.eval('return await window.shopilot.store.list()')
    check('restored current build preserves fixture store', restoredStores?.ok === true && (restoredStores.data || []).some(store => store.name === 'rollback-fixture'))
    await stop(context); context = null

    const removed = await uninstall(installDir)
    check('rollback rehearsal cleanup removes temporary install directory', removed && !fs.existsSync(path.join(installDir, 'ShopPilot.exe')))
    check('rollback rehearsal preserves temporary user data for recovery', fs.existsSync(userData))
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) {
    report.error = String(error?.stack || error)
    console.error('INSTALLER_ROLLBACK_FAIL', report.error)
  } finally {
    await stop(context)
    try { await uninstall(installDir) } catch {}
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'installer-rollback-report.json'), JSON.stringify(report, null, 2))
  }
  if (report.status !== 'passed') process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
