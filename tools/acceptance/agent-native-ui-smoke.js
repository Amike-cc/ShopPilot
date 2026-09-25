/* Real Windows SendInput smoke for the packaged Agent settings surface. */
const { spawn, execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
const INPUT_HELPER = path.join(ROOT, 'tools', 'acceptance', 'win-input.ps1')
const PORT = Number(process.env.SHOPPILOT_NATIVE_UI_PORT || 9251)
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

async function waitFor(fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await sleep(200)
  }
  throw new Error('timeout waiting for native UI condition')
}

function nativeBatch(pid, steps) {
  const spec = Buffer.from(JSON.stringify(steps), 'utf8').toString('base64')
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INPUT_HELPER, '-Action', 'batch', '-TargetPid', String(pid), '-SpecB64', spec], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  const line = String(raw).trim().split(/\r?\n/).filter(Boolean).at(-1)
  return JSON.parse(line)
}

async function rectFor(cdp, selector) {
  return cdp.eval(`const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}`)
}

async function tabRectFor(cdp, label) {
  return cdp.eval(`const e=Array.from(document.querySelectorAll('[data-test="agent-admin-panel"] button.admin-tab')).find(node=>node.textContent.trim()===${JSON.stringify(label)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}`)
}

async function clickRect(pid, rect, scale = 1) {
  if (!rect || rect.w <= 0 || rect.h <= 0) throw new Error('native click target has no visible rectangle')
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return nativeBatch(pid, [
        { type: 'focus' },
        { type: 'sleep', ms: 450 },
        { type: 'click', cssX: rect.x + rect.w / 2, cssY: rect.y + rect.h / 2, scale },
        { type: 'sleep', ms: 350 }
      ])
    } catch (error) {
      lastError = error
      await sleep(300)
    }
  }
  throw lastError
}

function killTree(child) {
  if (!child?.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

async function main() {
  const report = { startedAt: new Date().toISOString(), status: 'failed', checks: [], note: 'Real Windows SendInput against the packaged ShopPilot window; no store write or paid model call.' }
  const check = (name, passed, detail = '') => {
    report.checks.push({ name, passed: !!passed, detail: String(detail).slice(0, 300) })
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  const userData = path.join(os.tmpdir(), `shopilot-native-ui-${Date.now()}`)
  let child
  let cdp
  try {
    if (!fs.existsSync(APP)) throw new Error(`packaged executable missing: ${APP}`)
    fs.mkdirSync(userData, { recursive: true })
    const fixtureAppData = path.join(userData, 'appdata')
    child = spawn(APP, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
      cwd: path.dirname(APP), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, SHOPPILOT_DISABLE_CDP_FP: '1' }
    })
    await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false))
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
    if (!target) throw new Error('packaged renderer target missing')
    cdp = new CDP(target.webSocketDebuggerUrl)
    await waitFor(() => cdp.eval('return !!window.shopilot && !!document.querySelector("[data-test=\\"settings-open-btn\\"]")').catch(() => false))
    const scale = Number(await cdp.eval('return window.devicePixelRatio || 1'))
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('invalid renderer devicePixelRatio')

    const focus = await waitFor(() => {
      try { return nativeBatch(child.pid, [{ type: 'focus' }]) } catch { return null }
    })
    check('real ShopPilot window can be focused through Windows SendInput helper', !!focus?.geometry?.clientW && !!focus?.geometry?.clientH, JSON.stringify(focus?.geometry || {}))

    const openRect = await rectFor(cdp, '[data-test="settings-open-btn"]')
    await clickRect(child.pid, openRect, scale)
    const settings = await waitFor(() => cdp.eval('return {open:!!document.querySelector("[data-test=\\"settings-dialog\\"]"),tabs:document.querySelectorAll("[data-test^=\\"settings-tab-\\"]").length}').catch(() => null))
    check('native click opens settings dialog', settings?.open === true && settings.tabs >= 5, JSON.stringify(settings))

    const agentSettingsRect = await waitFor(() => rectFor(cdp, '[data-test="settings-tab-agents"]'))
    await clickRect(child.pid, agentSettingsRect, scale)
    const team = await waitFor(() => cdp.eval('return {root:!!document.querySelector("[data-test=\\"agent-admin-panel\\"]"),org:!!document.querySelector("[data-test=\\"agent-org-panel\\"]")}').catch(() => null))
    check('native click opens Agent 团队 page', team?.root === true && team.org === true, JSON.stringify(team))

    for (const [label, selector] of [['组织 / HR', 'agent-org-panel'], ['模型 Profile', 'agent-model-panel'], ['本地记忆', 'agent-memory-panel'], ['Job 看板', 'agent-job-panel']]) {
      const rect = await waitFor(() => tabRectFor(cdp, label))
      await clickRect(child.pid, rect, scale)
      const visible = await waitFor(() => cdp.eval(`return !!document.querySelector('[data-test="${selector}"]')`).catch(() => false))
      check(`native click switches Agent subpage: ${label}`, visible === true)
    }
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) {
    report.error = String(error?.stack || error)
    console.error('NATIVE_UI_SMOKE_FAIL', report.error)
  } finally {
    report.finishedAt = new Date().toISOString()
    report.package = fs.existsSync(APP) ? { path: 'release/win-unpacked/ShopPilot.exe', bytes: fs.statSync(APP).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(APP)).digest('hex') } : null
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'native-ui-report.json'), JSON.stringify(report, null, 2))
    cdp?.close()
    killTree(child)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
  if (report.status !== 'passed') process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
