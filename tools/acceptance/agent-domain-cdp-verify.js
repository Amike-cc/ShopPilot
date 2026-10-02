/* Root-ceo-only Agent domain acceptance.
 * Uses a throwaway Electron profile and a local read-only page. The script
 * deliberately proves the new architecture instead of provisioning children.
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SHOPPILOT_AGENT_DOMAIN_PORT || 9238)
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
  const userData = path.join(os.tmpdir(), `shopilot-agent-domain-single-${Date.now()}`)
  let appProcess, cdp, server, storeId
  try {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Single Agent Evidence</title><main>只读页面证据</main>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const pageUrl = `http://127.0.0.1:${server.address().port}/evidence`
    fs.mkdirSync(userData, { recursive: true })
    const fixtureAppData = path.join(userData, 'appdata')
    appProcess = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, NODE_ENV: 'production', SHOPILOT_TEST_AUTOCONFIRM: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
    })
    const ready = await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.ok).catch(() => false))
    check('Electron Main 启动并暴露 CDP', ready)
    if (!ready) throw new Error('CDP endpoint not ready')
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot renderer target missing')
    cdp = new CDP(target.webSocketDebuggerUrl)
    check('Preload 暴露 Agent API', await cdp.eval('return !!window.shopilot?.agentDomain'))

    const org = await cdp.eval('return await window.shopilot.agentDomain.orgList({limit:200})')
    const items = org.ok ? (org.data.items || []) : []
    const root = items.find(item => item.id === 'root-ceo')
    check('迁移后只存在 active root-ceo', org.ok && items.length === 1 && root?.status === 'active' && root.parentId === null, JSON.stringify(items.map(item => ({ id: item.id, status: item.status }))))
    check('root-ceo 禁止创建 Agent', root?.toolPolicy?.canCreateAgent === false, JSON.stringify(root?.toolPolicy || {}))

    const context = await cdp.eval('return await window.shopilot.agent.softwareContext()')
    check('软件上下文只返回 root-ceo', context.ok && (context.data.agents || []).length === 1 && context.data.agents[0]?.id === 'root-ceo', JSON.stringify(context.data?.agents || []))

    const childDelegate = await cdp.eval(`return await window.shopilot.agentDomain.jobDelegate({assignedAgentId:'legacy-child',goal:'不得创建子 Agent',storeId:'legacy-store',run:false,browserTask:{name:'兼容拒绝',steps:[{type:'readText',input:{selector:'title'}}]}})`)
    check('派单到历史子 Agent 返回 AGENT_SINGLETON_ONLY', childDelegate?.ok === false && childDelegate.error?.code === 'AGENT_SINGLETON_ONLY', childDelegate?.error?.code || '')

    const store = await cdp.eval(`return await window.shopilot.store.create({name:'单 Agent 临时店',platform:'测试平台',adminUrl:${JSON.stringify(pageUrl)}})`)
    storeId = store.ok ? store.data.id : null
    check('创建临时店铺供 root-ceo Job 使用', !!storeId, store.error?.code || '')
    const delegated = storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobDelegate({goal:'root-ceo 直接执行只读页面 Job',storeId:${JSON.stringify(storeId)},run:true,browserTask:{name:'root-ceo 读取页面标题',storeScope:${JSON.stringify(storeId)},steps:[{type:'navigate',input:{url:${JSON.stringify(pageUrl)}}},{type:'readText',input:{selector:'title',privacyRedact:true}}]}})`) : null
    check('root-ceo 创建并启动 Job 且自身为执行者', delegated?.ok && delegated.data.executor.id === 'root-ceo' && delegated.data.job.createdByAgentId === 'root-ceo' && delegated.data.job.assignedAgentId === 'root-ceo' && ['running', 'succeeded'].includes(delegated.data.job.status), JSON.stringify(delegated?.data || delegated?.error || {}))
    if (delegated?.ok) {
      const jobId = delegated.data.job.id
      const job = await waitFor(async () => {
        const current = await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(jobId)})`)
        return current?.ok && ['succeeded', 'failed', 'cancelled', 'blocked_permission', 'recovery_required'].includes(current.data.status) ? current : null
      }, 30000)
      check('Job 快照的 actor/assignedAgentId 均为 root-ceo', job?.ok && job.data.createdByAgentId === 'root-ceo' && job.data.assignedAgentId === 'root-ceo' && job.data.permissionSnapshot?.assignedAgentId === 'root-ceo' && job.data.permissionSnapshot?.actorId === 'root-ceo', JSON.stringify(job?.data?.permissionSnapshot || {}))
      check('root-ceo Job 通过 TaskRunner 完成并落库步骤证据', job?.ok && job.data.status === 'succeeded' && !!job.data.browserRunId && (job.data.results || []).length >= 2 && (job.data.results || []).every(result => result.taskRunId === job.data.browserRunId), JSON.stringify({ status: job?.data?.status, browserRunId: job?.data?.browserRunId, results: job?.data?.results?.length || 0 }))
    }
    const childCreate = await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:'legacy-child',storeId:null,goal:'拒绝旧执行者',inputSummary:{},priority:40,requiresConfirmation:false,idempotencyKey:'single-child-${Date.now()}',browserTask:null})`)
    check('直接创建到旧 assignedAgentId 返回 AGENT_SINGLETON_ONLY', childCreate?.ok === false && childCreate.error?.code === 'AGENT_SINGLETON_ONLY', childCreate?.error?.code || '')

    const models = await cdp.eval('return await window.shopilot.agentDomain.modelList({limit:200})')
    check('模型 Profile 仍由主 Agent 统一管理', models.ok && (models.data.items || []).some(item => item.id === 'model_default-main'), JSON.stringify(models.data?.items?.map(item => item.id) || []))
    const memory = await cdp.eval(`return await window.shopilot.agentDomain.memoryWrite({agentId:'root-ceo',storeId:null,scope:'shared',type:'semantic',title:'单 Agent 验收记忆',content:'root-ceo 统一治理 Job 和记忆。',confidence:0.9,sensitivity:'low'})`)
    const reviewed = memory?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.memoryReview({memoryId:${JSON.stringify(memory.data.id)},status:'approved',reviewerAgentId:'root-ceo'})`) : null
    check('记忆写入与审核仍归属 root-ceo', memory?.ok && reviewed?.ok && reviewed.data.agentId === 'root-ceo', reviewed?.error?.code || '')

    if (storeId) {
      await cdp.eval(`return await window.shopilot.browser.close(${JSON.stringify(storeId)})`).catch(() => null)
      await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(storeId)})`).catch(() => null)
    }
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack || error)
    console.error('AGENT_DOMAIN_CDP_FAIL', report.error)
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, note: 'root-ceo-only local fixture; no real store or paid model call' }, null, 2))
    cdp?.close()
    if (server) await new Promise(resolve => server.close(resolve))
    if (appProcess && appProcess.exitCode == null) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    await sleep(500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
  const failed = report.checks.filter(item => !item.passed)
  console.log(`Agent domain CDP: ${report.status}; ${report.checks.length - failed.length}/${report.checks.length}`)
  process.exitCode = report.status === 'passed' ? 0 : 1
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
