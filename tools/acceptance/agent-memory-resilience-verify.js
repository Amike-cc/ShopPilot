/* Chat-only capability acceptance: Agent memory, jobs, skills and plugins are
 * internal Main services and are intentionally absent from the renderer API. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
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

async function main() {
  const occupied = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false)
  if (occupied) throw new Error(`CDP 端口 ${PORT} 已被占用`)
  const userData = path.join(os.tmpdir(), `shopilot-agent-memory-boundary-${Date.now()}`)
  const appData = path.join(userData, 'appdata')
  fs.mkdirSync(appData, { recursive: true })
  const child = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
  })
  let cdp
  const results = []
  const check = (name, passed, detail = '') => {
    results.push(!!passed)
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  try {
    const deadline = Date.now() + 30000
    let ready = false
    while (Date.now() < deadline) {
      ready = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false)
      if (ready) break
      await sleep(250)
    }
    if (!ready) throw new Error('CDP endpoint not ready')
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot renderer target missing')
    cdp = new CDP(target.webSocketDebuggerUrl)
    const api = await cdp.eval(`return {agent:Object.keys(window.shopilot?.agent||{}).sort(),settings:Object.keys(window.shopilot?.agentSettings||{}).sort(),domain:typeof window.shopilot?.agentDomain}`)
    check('Agent 无可调用的记忆写入、审核、快照恢复 API', api.agent.join(',') === 'chat,uiGet,uiSet' && api.domain === 'undefined', JSON.stringify(api))
    check('Agent 管理桥已全部关闭（模型配置随设置页签一起下线）', api.settings.join(',') === '', JSON.stringify(api.settings))
    console.log(`Agent memory boundary: ${results.every(Boolean) ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  } finally {
    cdp?.close()
    if (child.exitCode == null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    await sleep(400)
    if (path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(userData).startsWith('shopilot-agent-memory-boundary-')) {
      try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
    }
  }
}

main().catch(error => { console.error('AGENT_CHAT_MEMORY_BOUNDARY_FAIL', error?.stack || error); process.exitCode = 1 })
