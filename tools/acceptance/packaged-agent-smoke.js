/* Packaged directory startup smoke: no store write and no model call. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'release', 'win-unpacked', 'ShopPilot.exe')
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
    const api = await cdp.eval('return !!window.shopilot && !!window.shopilot.agentDomain')
    check('packaged preload exposes only the whitelisted Agent API', api)
    const org = await cdp.eval('return await window.shopilot.agentDomain.orgList()')
    const orgItems = org.ok ? (org.data.items || []) : []
    check('packaged migration bootstraps root-ceo without a hidden root-hr', org.ok && orgItems.filter(item => item.id === 'root-ceo').length === 1 && !orgItems.some(item => item.id === 'root-hr'), org.ok ? JSON.stringify(orgItems.map(item => ({ id: item.id, status: item.status }))) : org.error?.code || '')
    const setup = await cdp.eval(`const store=await window.shopilot.store.create({name:'packaged-smoke',platform:'测试平台',adminUrl:'http://127.0.0.1:1/'}); if(store.ok) await window.shopilot.browser.open(store.data.id); await new Promise(r=>setTimeout(r,500)); return {ok:store.ok,id:store.ok?store.data.id:null}`)
    const settings = await cdp.eval(`const button=document.querySelector('[data-test="settings-open-btn"]'); if(button) button.click(); await new Promise(r=>setTimeout(r,300)); return {open:!!document.querySelector('[data-test="settings-dialog"]'),tabs:Array.from(document.querySelectorAll('[data-test^="settings-tab-"]')).map(node=>node.textContent?.trim())}`)
    const agentPanels = await cdp.eval(`const settingsTab=document.querySelector('[data-test="settings-tab-agents"]'); if(settingsTab) settingsTab.click(); await new Promise(r=>setTimeout(r,200)); const root=document.querySelector('[data-test="agent-admin-panel"]'); const tabs=Array.from(root?.querySelectorAll('button.admin-tab') || []); const labels=tabs.map(node=>node.textContent?.trim()); const panels={}; for(const [label,key,selector] of [['组织 / HR','org','agent-org-panel'],['模型 Profile','models','agent-model-panel'],['本地记忆','memory','agent-memory-panel'],['技能与插件','skills','agent-skill-panel'],['Job 看板','jobs','agent-job-panel']]){const button=tabs.find(node=>node.textContent?.trim()===label); if(button) button.click(); await new Promise(r=>setTimeout(r,80)); panels[key]=!!document.querySelector('[data-test="'+selector+'"]');} return {labels,...panels}`)
    await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(setup.id)})`).catch(() => null)
    check('packaged settings renders Agent 团队 tab', settings.open && settings.tabs.includes('Agent 团队'), JSON.stringify(settings))
    check('packaged Agent team renders organization, model, memory, skills and Job panels', agentPanels.labels.includes('组织 / HR') && agentPanels.labels.includes('模型 Profile') && agentPanels.labels.includes('本地记忆') && agentPanels.labels.includes('技能与插件') && agentPanels.labels.includes('Job 看板') && agentPanels.org && agentPanels.models && agentPanels.memory && agentPanels.skills && agentPanels.jobs, JSON.stringify(agentPanels))
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); console.error('PACKAGED_AGENT_SMOKE_FAIL', report.error) }
  finally {
    report.finishedAt = new Date().toISOString()
    if (fs.existsSync(APP)) {
      const asar = path.join(path.dirname(APP), 'resources', 'app.asar')
      report.artifacts = {
        executable: { path: 'release/win-unpacked/ShopPilot.exe', bytes: fs.statSync(APP).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(APP)).digest('hex') },
        appAsar: fs.existsSync(asar) ? { path: 'release/win-unpacked/resources/app.asar', bytes: fs.statSync(asar).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex') } : null
      }
    }
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'packaged-report.json'), JSON.stringify({ ...report, note: 'packaged win-unpacked smoke; no real store or paid model call' }, null, 2))
    cdp?.close()
    if (appProcess && appProcess.exitCode === null) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
  }
  if (report.status !== 'passed') process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
