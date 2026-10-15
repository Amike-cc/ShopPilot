/* Packaged-style boundary acceptance: the renderer gets plain chat only,
 * while Agent Job/skill/memory/model management APIs remain outside the preload bridge. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SHOPILOT_AGENT_DOMAIN_PORT || 9238)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const reportPath = path.join(ROOT, 'artifacts', 'agent', 'cdp-report.json')

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
  async eval(body) {
    await this.ready
    const id = ++this.id
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function waitFor(fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  return null
}

async function main() {
  const report = { startedAt: new Date().toISOString(), status: 'partial', checks: [] }
  const check = (name, passed, detail = '') => {
    report.checks.push({ name, passed: !!passed, detail: String(detail).slice(0, 300) })
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  const userData = path.join(os.tmpdir(), `shopilot-agent-chat-boundary-${Date.now()}`)
  let appProcess, cdp
  try {
    const occupied = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false)
    if (occupied) throw new Error(`CDP 端口 ${PORT} 已被占用`)
    fs.mkdirSync(path.join(userData, 'appdata'), { recursive: true })
    appProcess = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: path.join(userData, 'appdata'), LOCALAPPDATA: path.join(userData, 'appdata'), NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })
    const ready = await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false))
    check('Electron Main 启动并暴露 CDP', ready)
    if (!ready) throw new Error('CDP endpoint not ready')
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot renderer target missing')
    cdp = new CDP(target.webSocketDebuggerUrl)

    const bridge = await cdp.eval(`return {agent:Object.keys(window.shopilot?.agent||{}).sort(),settings:Object.keys(window.shopilot?.agentSettings||{}).sort(),domain:typeof window.shopilot?.agentDomain,task:{create:typeof window.shopilot?.task?.create,run:typeof window.shopilot?.task?.run}}`)
    check('Agent bridge 只包含文本聊天与抽屉状态', bridge.agent.join(',') === 'chat,uiGet,uiSet' && bridge.domain === 'undefined', JSON.stringify(bridge))
    check('手动工作台任务仍由原 task API 独立提供', bridge.task.create === 'function' && bridge.task.run === 'function', JSON.stringify(bridge.task))
    check('Agent 模型管理桥已下线（模型统一在「AI 配置」管理）', bridge.settings.join(',') === '', JSON.stringify(bridge.settings))

    const orbReady = await waitFor(() => cdp.eval('return !!document.querySelector(".agent-orb")').catch(() => false))
    if (!orbReady) throw new Error('Agent chat launcher did not render')
    const drawer = await cdp.eval(`document.querySelector('.agent-orb')?.click(); await new Promise(r=>setTimeout(r,250)); return {open:!!document.querySelector('[data-test="agent-floating-drawer"]'),note:document.querySelector('[data-test="agent-chat-only"]')?.textContent?.trim()||'',shortcuts:document.querySelectorAll('.agent-shortcuts button').length,plans:document.querySelectorAll('.agent-plan-card,.agent-software-plan-card').length,placeholder:document.querySelector('.agent-composer textarea')?.placeholder||''}`)
    check('Agent 面板只显示普通对话', drawer.open && drawer.note.includes('纯对话模式') && drawer.shortcuts === 0 && drawer.plans === 0 && drawer.placeholder.includes('想聊'), JSON.stringify(drawer))

    const settings = await cdp.eval(`const nav=[...document.querySelectorAll('.dashboard-nav-item')].find(node=>node.textContent?.includes('设置')); nav?.click(); await new Promise(r=>setTimeout(r,250)); const tabs=[...document.querySelectorAll('.settings-nav button')].map(node=>node.textContent?.trim()); return {tabs,modelPanel:!!document.querySelector('[data-agent-panel="models"]'),agentPanel:!!document.querySelector('[data-test="agent-admin-panel"]'),otherPanels:document.querySelectorAll('[data-test="agent-job-panel"],[data-test="agent-memory-panel"],[data-test="agent-org-panel"]').length}`)
    check('设置页不再提供 Agent 模型页签（模型统一在「AI 配置」）', !settings.tabs.includes('Agent 模型') && settings.tabs.includes('AI 配置') && !settings.tabs.includes('技能') && !settings.tabs.includes('插件') && !settings.modelPanel && !settings.agentPanel && settings.otherPanels === 0, JSON.stringify(settings))

    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack || error)
    console.error('AGENT_CHAT_BOUNDARY_CDP_FAIL', report.error)
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, note: 'isolated Electron profile; chat and settings bridge boundary only' }, null, 2))
    cdp?.close()
    if (appProcess && appProcess.exitCode == null) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    await sleep(500)
    const tempRoot = path.resolve(os.tmpdir())
    if (path.resolve(userData).startsWith(tempRoot + path.sep) && path.basename(userData).startsWith('shopilot-agent-chat-boundary-')) {
      try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
    }
  }
  const failed = report.checks.filter(item => !item.passed)
  console.log(`Agent chat boundary CDP: ${report.status}; ${report.checks.length - failed.length}/${report.checks.length}`)
  process.exitCode = report.status === 'passed' ? 0 : 1
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
