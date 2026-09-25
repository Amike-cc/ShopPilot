/**
 * Deterministic Main-only memory I/O failure acceptance.
 * This simulates power-loss/disk-full timing without filling a real disk.
 * The fault switch is accepted only by the test process environment.
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SHOPILOT_MEMORY_RESILIENCE_PORT || 9240)
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

async function waitFor(fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(200)
  }
  throw new Error('timeout waiting for acceptance condition')
}

function listTempFiles(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const queue = [root]
  while (queue.length) {
    const current = queue.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name.includes('.tmp-')) found.push(full)
    }
  }
  return found
}

function listSnapshotFiles(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).filter(name => /^snapshot-.*\.bin$/i.test(name)).map(name => path.join(root, name))
}

async function stopProcess(child) {
  if (child?.pid) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
  await sleep(500)
}

async function runFault(mode, report) {
  const userData = path.join(os.tmpdir(), `shopilot-memory-resilience-${mode}-${Date.now()}`)
  const fixtureAppData = path.join(userData, 'appdata')
  fs.mkdirSync(userData, { recursive: true })
  let appProcess
  let cdp
  try {
    const occupied = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(res => res.ok).catch(() => false)
    if (occupied) throw new Error(`专用端口 ${PORT} 已被占用`)
    appProcess = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_MEMORY_TEST_FAULT: mode }
    })
    await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(res => res.ok).catch(() => false), 30000)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot main window target not found')
    cdp = new CDP(target.webSocketDebuggerUrl)
    await waitFor(async () => cdp.eval('return !!window.shopilot').catch(() => false), 15000)
    const isSnapshotFault = mode.startsWith('snapshot-')
    const result = isSnapshotFault
      ? await cdp.eval('return await window.shopilot.agentDomain.memorySnapshot()')
      : await cdp.eval(`return await window.shopilot.agentDomain.memoryWrite({agentId:'root-ceo',storeId:null,scope:'shared',type:'semantic',title:'故障注入验收',content:'写入失败后不应留下半成品。',confidence:0.5,sensitivity:'low'})`)
    const listed = await cdp.eval(`return await window.shopilot.agentDomain.memoryList({agentId:'root-ceo',limit:20})`)
    const memoryRoot = path.join(fixtureAppData, 'ShopPilot', 'agent-memory')
    let manifestEntries = 0
    const manifestPath = path.join(memoryRoot, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      try { manifestEntries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries?.length || 0 } catch {}
    }
    const tempFiles = listTempFiles(memoryRoot)
    const snapshotFiles = listSnapshotFiles(memoryRoot)
    const passed = result?.ok === false && result.error?.code === 'AGENT_MEMORY_IO_FAILED' && listed?.ok && listed.data.items.length === 0 && manifestEntries === 0 && tempFiles.length === 0 && snapshotFiles.length === 0
    report.checks.push({ name: `memory atomic rollback: ${mode}`, passed, detail: JSON.stringify({ errorCode: result?.error?.code || null, itemCount: listed?.data?.items?.length ?? null, manifestEntries, tempFiles: tempFiles.length, snapshotFiles: snapshotFiles.length }) })
    console.log(`${passed ? 'PASS' : 'FAIL'} - memory atomic rollback: ${mode}`)
  } finally {
    cdp?.close()
    await stopProcess(appProcess)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  const report = { startedAt: new Date().toISOString(), status: 'failed', checks: [], note: 'Deterministic acceptance-only power-loss/disk-full timing; no real disk was filled and no production fault switch is enabled.' }
  try {
    for (const mode of ['power-loss-before-rename', 'disk-full-after-file', 'disk-full-after-manifest', 'snapshot-power-loss-before-rename']) await runFault(mode, report)
    report.status = report.checks.every(check => check.passed) ? 'passed' : 'failed'
  } catch (error) {
    report.error = String(error?.stack || error)
    console.error('MEMORY_RESILIENCE_FAIL', report.error)
  }
  report.finishedAt = new Date().toISOString()
  fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'memory-resilience-report.json'), JSON.stringify(report, null, 2))
  console.log(`Memory resilience: ${report.status}; ${report.checks.filter(check => check.passed).length}/${report.checks.length}`)
  process.exitCode = report.status === 'passed' ? 0 : 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
