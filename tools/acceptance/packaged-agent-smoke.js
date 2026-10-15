/* Packaged directory startup smoke: no store write and no model call. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '../..')
const APP = process.env.SHOPILOT_PACKAGED_APP ? path.resolve(process.env.SHOPILOT_PACKAGED_APP) : path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
const APP_LABEL = path.relative(ROOT, APP)
const PORT = Number(process.env.SHOPPILOT_PACKAGED_PORT || 9240)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(250) } return null }
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject }); this.ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id == null) return; const pending = this.pending.get(msg.id); if (!pending) return; this.pending.delete(msg.id); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result) } }
  async eval(code) { await this.ready; const id = ++this.id; const result = await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true } })) }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value }
  close() { try { this.ws.close() } catch {} }
}
async function main() {
  const report = { startedAt: new Date().toISOString(), status: 'partial', checks: [] }
  const check = (name, passed, detail = '') => { report.checks.push({ name, passed: !!passed, detail: String(detail).slice(0, 300) }); console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`) }
  const userData = path.join(os.tmpdir(), `shopilot-packaged-agent-${Date.now()}`)
  let appProcess, cdp
  try {
    if (!fs.existsSync(APP)) throw new Error(`packaged executable missing: ${APP}`)
    fs.mkdirSync(userData, { recursive: true })
    const fixtureAppData = path.join(userData, 'appdata')
    appProcess = spawn(APP, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], { cwd: path.dirname(APP), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, SHOPPILOT_DISABLE_CDP_FP: '1' } })
    const ready = await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false))
    check('packaged ShopPilot.exe starts and exposes CDP', ready)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
    check('packaged renderer target is available', !!target)
    if (!target) throw new Error('packaged renderer target missing')
    cdp = new CDP(target.webSocketDebuggerUrl)
    const api = await cdp.eval('return {agent:Object.keys(window.shopilot?.agent||{}).sort(),settings:Object.keys(window.shopilot?.agentSettings||{}).sort(),domain:typeof window.shopilot?.agentDomain}')
    check('packaged Agent bridge exposes chat and UI state only', api.agent.join(',') === 'chat,uiGet,uiSet' && api.domain === 'undefined', JSON.stringify(api))
    check('packaged Agent model settings bridge is removed (models live in AI 配置)', api.settings.join(',') === '', JSON.stringify(api.settings))
    const setup = await cdp.eval(`const store=await window.shopilot.store.create({name:'packaged-smoke',platform:'测试平台',adminUrl:'http://127.0.0.1:1/'}); if(store.ok) await window.shopilot.browser.open(store.data.id); await new Promise(r=>setTimeout(r,500)); const home=document.querySelector('.home-return'); if(home) home.click(); await new Promise(r=>setTimeout(r,300)); return {ok:store.ok,id:store.ok?store.data.id:null}`)
    const settings = await cdp.eval(`const button=[...document.querySelectorAll('.dashboard-nav-item')].find(node=>node.textContent?.includes('设置')); if(button) button.click(); await new Promise(r=>setTimeout(r,300)); return {open:!!document.querySelector('[data-test="unified-settings-page"]'),tabs:Array.from(document.querySelectorAll('.settings-nav button')).map(node=>node.textContent?.trim())}`)
    const agentPanels = await cdp.eval(`return {model:!!document.querySelector('[data-agent-panel="models"]'),agentPanel:!!document.querySelector('[data-test="agent-admin-panel"]'),job:!!document.querySelector('[data-test="agent-job-panel"]'),memory:!!document.querySelector('[data-test="agent-memory-panel"]')}`)
    await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(setup.id)})`).catch(() => null)
    check('packaged settings no longer renders Agent 模型 tab', settings.open && !settings.tabs.some(label => label.includes('Agent 模型')) && settings.tabs.some(label => label.includes('AI 配置')) && !settings.tabs.some(label => label.includes('技能') || label.includes('插件')), JSON.stringify(settings))
    check('packaged Agent model panel and operation setup are removed', agentPanels.model === false && agentPanels.agentPanel === false && !agentPanels.job && !agentPanels.memory, JSON.stringify(agentPanels))
    check('packaged Agent Job and memory methods are not exposed', api.domain === 'undefined' && !api.settings.some(key => /job|memory|skill|plugin/i.test(key)), JSON.stringify({ domain: api.domain, settings: api.settings }))
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); console.error('PACKAGED_AGENT_SMOKE_FAIL', report.error) }
  finally {
    report.finishedAt = new Date().toISOString()
    if (fs.existsSync(APP)) {
      const asar = path.join(path.dirname(APP), 'resources', 'app.asar')
      report.artifacts = {
        executable: { path: APP_LABEL, bytes: fs.statSync(APP).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(APP)).digest('hex') },
        appAsar: fs.existsSync(asar) ? { path: path.relative(ROOT, asar), bytes: fs.statSync(asar).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex') } : null
      }
    }
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'packaged-report.json'), JSON.stringify({ ...report, note: 'packaged win-unpacked smoke; no real store or paid model call' }, null, 2))
    cdp?.close()
    if (appProcess && appProcess.exitCode === null) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    const tempRoot = path.resolve(os.tmpdir())
    if (path.resolve(userData).startsWith(tempRoot + path.sep) && path.basename(userData).startsWith('shopilot-packaged-agent-')) {
      try { fs.rmSync(userData, { recursive: true, force: true }) } catch (error) { console.warn('temporary package smoke data cleanup failed:', String(error).slice(0, 120)) }
    }
  }
  if (report.status !== 'passed') process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
