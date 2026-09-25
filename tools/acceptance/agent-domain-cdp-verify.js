/* Real Electron/Preload acceptance for A-M0..A-M4 domain contracts.
 * Uses a throwaway userData directory and a local read-only page only. */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SHOPPILOT_AGENT_DOMAIN_PORT || 9238)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let flaky429Count = 0

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject }); this.ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id == null) return; const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } }
  async eval(code) { await this.ready; const id = ++this.id; const result = await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true } })) }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value }
  close() { try { this.ws.close() } catch {} }
}

async function waitFor(fn, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250) } return null }
async function main() {
  const report = { startedAt: new Date().toISOString(), checks: [], status: 'partial' }
  const check = (name, passed, detail = '') => { report.checks.push({ name, passed: !!passed, detail: String(detail).slice(0, 300) }); console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`) }
  const optional = (name, status, detail = '') => { (report.optionalChecks || (report.optionalChecks = [])).push({ name, status, detail: String(detail).slice(0, 300) }); console.log(`OPTIONAL ${status.toUpperCase()} - ${name}${detail ? ` :: ${detail}` : ''}`) }
  const userData = path.join(os.tmpdir(), `shopilot-agent-domain-${Date.now()}`)
  fs.mkdirSync(userData, { recursive: true })
  let appProcess, cdp, server, storeId, otherStoreId, childId, profileId, browserJobId, modelJobId
  try {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && String(req.url || '').includes('/v1/chat/completions')) {
        const respond = () => {
          const url = String(req.url || '')
          if (url.includes('/flaky/') && flaky429Count === 0) { flaky429Count += 1; res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture rate limited' } })); return }
          if (url.includes('/fail/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture provider overloaded' } })); return }
          if (url.includes('/unauthorized/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture invalid key' } })); return }
          if (url.includes('/invalid/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); return }
          const content = url.includes('/empty/') ? '' : url.includes('/json/') ? '{"ok":true}' : '本地模型可审核摘要'
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 7 } }))
        }
        req.resume()
        if (String(req.url || '').includes('/hang/')) return
        if (String(req.url || '').includes('/slow/')) setTimeout(respond, 1500)
        else respond()
        return
      }
      if (String(req.url || '').includes('/orders')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><title>Domain Orders</title></head><body>
          <table id="orders"><thead><tr><th>订单号</th><th>订单状态</th><th>实付金额</th><th>下单时间</th></tr></thead>
          <tbody>
            <tr><td>O-1001</td><td>已发货</td><td>￥99.00</td><td>2026-09-25 10:00</td></tr>
            <tr><td>O-1002</td><td>待发货</td><td>￥19.90</td><td>2026-09-25 11:30</td></tr>
          </tbody></table>
        </body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Domain Job Evidence</title><main>只读页面证据</main>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const pageUrl = `http://127.0.0.1:${server.address().port}/read-only`
    const fixtureAppData = path.join(userData, 'appdata')
    appProcess = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
    let logs = ''
    appProcess.stdout.on('data', chunk => { logs += chunk.toString() })
    appProcess.stderr.on('data', chunk => { logs += chunk.toString() })
    await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.ok).catch(() => false), 30000)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot main window CDP target not found')
    cdp = new CDP(target.webSocketDebuggerUrl)
    const ready = await cdp.eval('return !!window.shopilot')
    check('Preload exposes only the ShopPilot API', ready)

    const org = await cdp.eval('return await window.shopilot.agentDomain.orgList()')
    const orgItems = org.ok ? (org.data.items || []) : []
    const root = orgItems.find(item => item.id === 'root-ceo')
    check('v6 migration bootstraps exactly one active root-ceo', !!root && root.parentId === null && root.status === 'active' && orgItems.filter(item => item.id === 'root-ceo').length === 1, JSON.stringify(root || {}))
    check('default-main profile is bound through agent_model_bindings', !!root?.modelProfileId && root.modelProfileId === 'model_default-main')

    const created = await cdp.eval(`return await window.shopilot.agentDomain.orgCreate({actorAgentId:'root-ceo',confirmed:true,name:'只读巡检试用',role:'operator',description:'读取商品库存和状态，不执行写操作',storeScope:{storeIds:[],readOnly:true},memoryScope:{write:false},maxConcurrency:1})`)
    childId = created.ok ? created.data.id : null
    check('HR confirmation creates a probation child Agent', created.ok && created.data.status === 'probation' && created.data.parentId === 'root-ceo', created.error?.code || '')
    const inheritedJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'校验子 Agent 未绑定模型时继承主 Agent AI 配置',inputSummary:{source:'local-inherit-model-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-inherit-${Date.now()}',browserTask:null})`) : null
    check('child Agent without a model binding inherits the main AI config snapshot', !!inheritedJob?.ok && inheritedJob.data.modelSnapshot?.modelProfile?.id === 'model_default-main' && inheritedJob.data.permissionSnapshot?.modelSource === 'inherited' && inheritedJob.data.permissionSnapshot?.assignedAgentId === childId, inheritedJob?.error?.code || JSON.stringify(inheritedJob?.data?.modelSnapshot || {}))
    if (inheritedJob?.ok) await cdp.eval(`return await window.shopilot.agentDomain.jobCancel(${JSON.stringify(inheritedJob.data.id)})`).catch(() => null)
    const aiConfigJob = childId ? await cdp.eval(`const synced=await window.shopilot.ai.configSet({endpoint:${JSON.stringify(pageUrl)},model:'fixture-main-config'}); const job=await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'校验设置页 AI 配置同步到主 Agent 并被子 Agent 继承',inputSummary:{source:'local-ai-config-sync-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-ai-sync-${Date.now()}',browserTask:null}); if(job.ok) await window.shopilot.agentDomain.jobCancel(job.data.id); return {synced,job}`) : null
    check('settings AI config syncs to the main profile and the child inheritance snapshot', !!aiConfigJob?.synced?.ok && !!aiConfigJob?.job?.ok && aiConfigJob.job.data.modelSnapshot?.modelProfile?.id === 'model_default-main' && String(aiConfigJob.job.data.modelSnapshot?.modelProfile?.endpoint || '').includes(pageUrl) && aiConfigJob.job.data.modelSnapshot?.modelProfile?.model === 'fixture-main-config', aiConfigJob?.job?.error?.code || JSON.stringify({ synced: aiConfigJob?.synced?.data, snapshot: aiConfigJob?.job?.data?.modelSnapshot }))
    const rootAssignee = await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:'root-ceo',storeId:null,goal:'读取本地页面标题',inputSummary:{source:'local-root-assignee-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-root-assignee-${Date.now()}',browserTask:null})`)
    check('root-ceo can never be the assigned executor of a Job', rootAssignee?.ok === false && rootAssignee.error.code === 'AGENT_ROOT_CANNOT_EXECUTE', rootAssignee?.error?.code || JSON.stringify(rootAssignee?.data || ''))
    const profile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Fixture Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-model',timeoutMs:5000})`)
    profileId = profile.ok ? profile.data.id : null
    check('model Profile CRUD returns hasKey only', profile.ok && profile.data.id && profile.data.hasKey === false && !JSON.stringify(profile.data).toLowerCase().includes('credential'), profile.error?.code || '')
    const fallbackProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Fallback Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-fallback',timeoutMs:5000})`)
    const fallbackProfileId = fallbackProfile.ok ? fallbackProfile.data.id : null
    const primaryFallback = profileId && fallbackProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelSet({id:${JSON.stringify(profileId)},name:'Local Fixture Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-model',timeoutMs:5000,fallbackProfileId:${JSON.stringify(fallbackProfileId)}})`) : null
    check('fallback binding accepts an enabled Profile', !!primaryFallback?.ok && primaryFallback.data.fallbackProfileId === fallbackProfileId, primaryFallback?.error?.code || '')
    const cycleAttempt = fallbackProfileId && profileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelSet({id:${JSON.stringify(fallbackProfileId)},name:'Local Fallback Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-fallback',timeoutMs:5000,fallbackProfileId:${JSON.stringify(profileId)}})`) : null
    check('fallback Profile cycles are rejected', cycleAttempt?.ok === false && cycleAttempt.error.code === 'AGENT_INVALID_INPUT', cycleAttempt?.error?.code || '')
    const disabledProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Disabled Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-disabled',timeoutMs:5000,enabled:false})`)
    const disabledFallback = profileId && disabledProfile?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.modelSet({id:${JSON.stringify(profileId)},name:'Local Fixture Profile',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-model',timeoutMs:5000,fallbackProfileId:${JSON.stringify(disabledProfile.data.id)}})`) : null
    check('disabled fallback Profile is rejected', disabledFallback?.ok === false && disabledFallback.error.code === 'AGENT_MODEL_NOT_FOUND', disabledFallback?.error?.code || '')
    const bound = childId && profileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(profileId)})`) : null
    check('each Agent can receive an independent model binding', !!bound?.ok && bound.data.modelProfileId === profileId)
    const unbound = childId ? await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},null)`) : null
    check('unbinding a child Agent returns it to the inherited main AI config', !!unbound?.ok && unbound.data.modelProfileId === null, unbound?.error?.code || JSON.stringify(unbound?.data?.modelProfileId))
    const rebound = childId && profileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(profileId)})`) : null
    if (!rebound?.ok) throw new Error(`child fixture re-bind failed: ${rebound?.error?.code || ''}`)

    const store = await cdp.eval(`return await window.shopilot.store.create({name:'Agent Domain 临时店',platform:'测试平台',adminUrl:${JSON.stringify(pageUrl)}})`)
    storeId = store.ok ? store.data.id : null
    check('creates an isolated temporary store for the browser evidence', !!storeId, store.error?.code || '')
    const autoProvision = childId && storeId ? await cdp.eval(`const r=await window.shopilot.agentDomain.jobDelegate({goal:'只读盘点本地页面',storeId:${JSON.stringify(storeId)},run:false,browserTask:{name:'只读盘点',steps:[{type:'readText',input:{selector:'title'}}]}}); if(r.ok) await window.shopilot.agentDomain.jobCancel(r.data.job.id); return r`) : null
    check('CEO 无可用子 Agent 时自动创建并激活执行岗（自治）', !!autoProvision?.ok && autoProvision.data.executor.id !== 'root-ceo' && autoProvision.data.executor.name === '执行助手' && autoProvision.data.provisioned === true, autoProvision?.error?.code || JSON.stringify(autoProvision?.data?.executor || ''))
    const opened = storeId ? await cdp.eval(`return await window.shopilot.browser.open(${JSON.stringify(storeId)})`) : null
    const tabInfo = storeId ? await waitFor(async () => { const r = await cdp.eval(`return await window.shopilot.browser.tab.list(${JSON.stringify(storeId)})`); return r.ok && r.data?.tabs?.[0] ? r.data.tabs[0] : null }, 15000) : null
    if (storeId && tabInfo?.id) await cdp.eval(`return await window.shopilot.browser.navigate(${JSON.stringify(storeId)},${JSON.stringify(tabInfo.id)},${JSON.stringify(pageUrl)})`)
    check('opens the isolated store and navigates its real WebContentsView', !!opened?.ok && !!tabInfo?.id)
    const browserTaskPayload = { name: 'Agent domain read-only evidence', storeScope: storeId, steps: [{ type: 'navigate', input: { url: pageUrl } }, { type: 'readText', input: { selector: 'title' } }] }
    const job = childId && storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(storeId)},goal:'读取本地只读页面标题并形成证据',inputSummary:{source:'local-read-only-fixture'},priority:50,requiresConfirmation:false,idempotencyKey:'domain-job-${Date.now()}',browserTask:${JSON.stringify(browserTaskPayload)}})`) : null
    browserJobId = job?.ok ? job.data.id : null
    check('Job creation freezes permission/store/memory/model snapshots', !!job?.ok && !!job.data.permissionSnapshot && !!job.data.storeScopeSnapshot && !!job.data.memoryScopeSnapshot && !!job.data.modelSnapshot && job.data.modelSnapshot.modelProfile?.id === profileId && String(job.data.modelSnapshot.modelProfile?.endpoint || '').includes(pageUrl) && job.data.modelSnapshot.modelProfile?.model === 'fixture-model' && !!browserJobId, job?.error ? `${job.error.code}: ${job.error.message}` : JSON.stringify(job?.data?.modelSnapshot || {}))
    const duplicate = browserJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(storeId)},goal:'读取本地只读页面标题并形成证据',inputSummary:{source:'local-read-only-fixture'},priority:50,requiresConfirmation:false,idempotencyKey:${JSON.stringify(job.data.idempotencyKey)},browserTask:${JSON.stringify(browserTaskPayload)}})`) : null
    check('same idempotency key reuses the single Job', !!duplicate?.ok && duplicate.data.id === browserJobId)
    const run = browserJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(browserJobId)})`) : null
    check('accepted Job uses the existing Main-only TaskRunner', !!run?.ok && !!run.data.browserRunId, run?.error?.code || '')
    const finished = browserJobId ? await waitFor(async () => { const r = await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(browserJobId)})`); return r.ok && ['succeeded','failed','cancelled'].includes(r.data.status) ? r.data : null }, 30000) : null
    const finalJobSnapshot = browserJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(browserJobId)})`).catch(() => null) : null
    check('Job → Task → TaskRun → evidence chain is real', !!finished && finished.status === 'succeeded' && finished.results.some(item => item.taskRunId && item.evidence), finished ? JSON.stringify({ status: finished.status, browserRunId: finished.browserRunId, events: finished.events, results: finished.results }) : JSON.stringify(finalJobSnapshot || 'no terminal job'))
    const resultId = finished?.results?.[0]?.id || null
    const reviewedResult = resultId ? await cdp.eval(`return await window.shopilot.agentDomain.jobResultReview({resultId:${JSON.stringify(resultId)},approved:true,reviewerAgentId:'root-ceo',correction:'本地只读证据审核'})`) : null
    const reviewedJob = browserJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(browserJobId)})`).catch(() => null) : null
    check('Job results require explicit review and retain the reviewer', !!reviewedResult?.ok && !!reviewedJob?.ok && !!reviewedJob.data?.results?.some(item => item.id === resultId && item.approved === true && item.reviewerAgentId === 'root-ceo'), reviewedResult?.error?.code || JSON.stringify(reviewedResult || ''))
    const risky = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(storeId)},goal:'发布商品',inputSummary:{},priority:50,requiresConfirmation:true,idempotencyKey:'domain-risk-${Date.now()}',browserTask:null})`) : null
    check('probation Agent cannot receive risky or confirmation jobs', risky?.ok === false && risky.error.code === 'AGENT_PERMISSION_DENIED', risky?.error?.code || '')
    const activated = childId ? await cdp.eval(`return await window.shopilot.agentDomain.orgActivate(${JSON.stringify(childId)},true)`) : null
    check('only explicit user confirmation activates probation Agent', !!activated?.ok && activated.data.status === 'active')
    const delegated = childId && storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobDelegate({goal:'读取本地只读页面标题并形成证据',storeId:${JSON.stringify(storeId)},planId:'local-delegate-plan',requiresConfirmation:false,run:true,browserTask:{name:'CEO 派单只读证据',steps:[{type:'navigate',input:{url:${JSON.stringify(pageUrl)}}},{type:'readText',input:{selector:'title'}}]}})`) : null
    const delegatedJobId = delegated?.ok ? delegated.data.job.id : null
    const delegatedFinished = delegatedJobId ? await waitFor(async () => { const r = await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(delegatedJobId)})`); return r.ok && ['succeeded', 'failed', 'cancelled', 'blocked_permission'].includes(r.data.status) ? r.data : null }, 30000) : null
    check('CEO chat delegation executes through a child Agent and records TaskRunner evidence', !!delegated?.ok && delegated.data.executor.id !== 'root-ceo' && delegated.data.job.assignedAgentId === delegated.data.executor.id && delegated.data.job.createdByAgentId === 'root-ceo' && !!delegated.data.job.browserTaskId && !!delegatedFinished && delegatedFinished.status === 'succeeded' && delegatedFinished.results.some(item => item.taskRunId && item.evidence), delegated?.error?.code || JSON.stringify({ executor: delegated?.data?.executor, job: delegated?.data?.job?.id, assigned: delegated?.data?.job?.assignedAgentId, status: delegatedFinished?.status, results: delegatedFinished?.results?.length }))
    // 真机修复：TaskRunner 只在店铺已打开时启动排队运行；浏览器 Job 必须自动打开目标店铺，
    // 否则运行永远排队、Job 卡在 running（经营数据采集踩过）。
    const closedStore = await cdp.eval(`return await window.shopilot.store.create({name:'Domain 未打开店铺',platform:'测试平台',adminUrl:${JSON.stringify(pageUrl)}})`)
    const closedStoreId = closedStore.ok ? closedStore.data.id : null
    const autoOpenJob = childId && closedStoreId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(closedStoreId)},goal:'未打开店铺的只读 Job 自动开店',inputSummary:{source:'local-auto-open-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-auto-open-${Date.now()}',browserTask:{name:'自动开店只读证据',storeScope:${JSON.stringify(closedStoreId)},steps:[{type:'navigate',input:{url:${JSON.stringify(pageUrl)}}},{type:'readText',input:{selector:'title'}}]}})`) : null
    const autoOpenRun = autoOpenJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(autoOpenJob.data.id)})`) : null
    const autoOpenFinished = autoOpenJob?.ok ? await waitFor(async () => { const r = await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(autoOpenJob.data.id)})`); return r.ok && ['succeeded', 'failed', 'cancelled'].includes(r.data.status) ? r.data : null }, 30000) : null
    check('浏览器 Job 在店铺未打开时自动打开店铺并真实执行', !!autoOpenJob?.ok && !!autoOpenRun?.ok && !!autoOpenFinished && autoOpenFinished.status === 'succeeded' && autoOpenFinished.results.some(item => item.evidence), autoOpenJob?.error?.code || JSON.stringify({ status: autoOpenFinished?.status, results: autoOpenFinished?.results?.length }))
    if (closedStoreId) await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(closedStoreId)})`).catch(() => null)
    const autonomyDelegated = storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobDelegate({goal:'点击只读页面并读取标题',storeId:${JSON.stringify(storeId)},run:true,browserTask:{name:'自治写操作',steps:[{type:'click',input:{selector:'main'}},{type:'readText',input:{selector:'title'}}]}})`) : null
    const autonomyJobId = autonomyDelegated?.ok ? autonomyDelegated.data.job.id : null
    const autonomyFinal = autonomyJobId ? await waitFor(async () => { const r = await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(autonomyJobId)})`); return r.ok && ['succeeded', 'failed', 'cancelled', 'blocked_permission'].includes(r.data.status) ? r.data : null }, 30000) : null
    check('非资金写操作任务无需审批即可派发运行（自治运营）', !!autonomyDelegated?.ok && !!autonomyFinal && autonomyFinal.status !== 'blocked_permission' && autonomyDelegated.data.executor.id !== childId, autonomyDelegated?.error?.code || JSON.stringify({ status: autonomyFinal?.status, executor: autonomyDelegated?.data?.executor }))
    const readOnlyDenied = childId && storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(storeId)},goal:'只读 Agent 的写任务',inputSummary:{source:'local-readonly-gate'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-readonly-${Date.now()}',browserTask:{name:'只读写任务',steps:[{type:'click',input:{selector:'main'}}]}})`) : null
    check('只读范围的 Agent 不能接收写操作 Job（权限模型 §4.2）', readOnlyDenied?.ok === false && readOnlyDenied.error.code === 'AGENT_PERMISSION_DENIED', readOnlyDenied?.error?.code || JSON.stringify(readOnlyDenied?.data || ''))
    const moneyJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'支付本地测试订单',inputSummary:{source:'local-money-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-money-${Date.now()}',browserTask:null})`) : null
    check('涉及资金的 Job 仍必须人工确认', moneyJob?.ok === false && moneyJob.error.code === 'AGENT_CONFIRMATION_REQUIRED', moneyJob?.error?.code || JSON.stringify(moneyJob?.data || ''))

    const skillSuite = await cdp.eval(`
      const mk = (action) => ({ id: 'step_' + Math.random().toString(36).slice(2), action, description: 'domain skill step', risk: 'read', requiresConfirmation: false })
      const plan = (steps) => ({ id: 'plan_' + Math.random().toString(36).slice(2), name: '域验收技能计划', goal: '域验收技能计划', steps: steps.map(mk), requiresConfirmation: false, status: 'draft' })
      const created = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'createSkill', name: 'Domain 巡检技能', description: '只读巡检', intent: '只读巡检', steps: [{ type: 'listStores', input: {} }, { type: 'listJobs', input: {} }] }]), true)
      const context = await window.shopilot.agent.softwareContext()
      const skills = context.ok ? context.data.skills : []
      const skill = skills.find(item => item.name === 'Domain 巡检技能')
      const run = skill ? await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'runSkill', skillId: skill.id }]), true) : null
      const moneyStep = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'createSkill', name: '危险技能', steps: [{ type: 'deleteStorePermanent', input: { storeId: 'store_missing' } }] }]), true)
      const restrictedStep = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'createSkill', name: '确认技能', steps: [{ type: 'deleteTask', input: { taskId: 'task_missing' } }] }]), true)
      const nested = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'createSkill', name: '嵌套技能', steps: [{ type: 'runSkill', input: { skillId: skill ? skill.id : 'skill_missing' } }] }]), true)
      const plugin = skill ? await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'createPlugin', name: 'Domain 巡检插件', description: '打包巡检技能', skillIds: [skill.id] }]), true) : null
      const pluginList = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'listPlugins' }]), true)
      const missing = await window.shopilot.agent.executeSoftwarePlan(plan([{ type: 'runSkill', skillId: 'skill_missing' }]), true)
      return { created, skills, skillFound: !!skill, run, moneyStep, restrictedStep, nested, plugin, pluginList, missing }
    `)
    check('技能：createSkill 走受控计划制作并进入软件上下文', !!skillSuite?.created?.ok && String(skillSuite.created.data.messages.join('；')).includes('已制作技能') && skillSuite.skillFound === true && skillSuite.skills.some(item => item.name === 'Domain 巡检技能' && item.stepCount === 2), skillSuite?.created?.error?.code || JSON.stringify(skillSuite?.skills || []).slice(0, 160))
    check('技能：runSkill 逐步执行并回传结果', !!skillSuite?.run?.ok && String(skillSuite.run.data.messages.join('；')).includes('执行完成') && String(skillSuite.run.data.messages.join('；')).includes('店铺'), skillSuite?.run?.error?.code || JSON.stringify(skillSuite?.run?.data?.messages || skillSuite?.run || '').slice(0, 160))
    check('技能：不能包含资金/不可逆工具', skillSuite?.moneyStep?.ok === false && skillSuite.moneyStep.error.code === 'AGENT_CONFIRMATION_REQUIRED', skillSuite?.moneyStep?.error?.code || '')
    check('技能：不能包含需要人工确认的软件动作（关店/删任务/组织变更等）', skillSuite?.restrictedStep?.ok === false && skillSuite.restrictedStep.error.code === 'AGENT_CONFIRMATION_REQUIRED', skillSuite?.restrictedStep?.error?.code || '')
    check('技能：不能嵌套技能或插件管理动作', skillSuite?.nested?.ok === false && skillSuite.nested.error.code === 'AGENT_INVALID_SKILL_STEP', skillSuite?.nested?.error?.code || '')
    check('插件：createPlugin 打包技能并可被列出', !!skillSuite?.plugin?.ok && !!skillSuite?.pluginList?.ok && String(skillSuite.pluginList.data.messages.join('；')).includes('插件'), skillSuite?.plugin?.error?.code || JSON.stringify(skillSuite?.pluginList?.data?.messages || '').slice(0, 160))
    check('技能：运行未知技能如实报错', skillSuite?.missing?.ok === false && skillSuite.missing.error.code === 'AGENT_SKILL_NOT_FOUND', skillSuite?.missing?.error?.code || '')
    const packSuite = await cdp.eval(`
      const exported = await window.shopilot.agentDomain.packExport({ skillNames: ['Domain 巡检技能'] })
      const unconfirmed = await window.shopilot.agentDomain.packImport(exported.ok ? exported.data.json : '{}', false)
      const basePack = {
        format: 'shopilot-agent-pack', version: 1, exportedAt: Date.now(),
        skills: [
          { name: 'Domain 导入技能', description: '导入验收', intent: '导入', steps: [{ type: 'listStores', input: {} }, { type: 'searchMemory', input: { query: '库存' } }] },
          { name: 'Domain 危险技能', steps: [{ type: 'deleteStorePermanent', input: { storeId: 'store_missing' } }] }
        ],
        plugins: [{ name: 'Domain 导入插件', description: '导入验收', skills: ['Domain 导入技能'] }]
      }
      const invalid = await window.shopilot.agentDomain.packImport(JSON.stringify(basePack), true)
      const goodPack = { ...basePack, skills: [basePack.skills[0]] }
      const imported = await window.shopilot.agentDomain.packImport(JSON.stringify(goodPack), true)
      const again = await window.shopilot.agentDomain.packImport(JSON.stringify(goodPack), true)
      const library = await window.shopilot.agentDomain.skillList()
      const missingRef = await window.shopilot.agentDomain.packImport(JSON.stringify({ ...goodPack, plugins: [{ name: 'Domain 空引用插件', skills: ['不存在的技能'] }] }), true)
      const badJson = await window.shopilot.agentDomain.packImport('not-json', true)
      return { exported, unconfirmed, invalid, imported, again, library, missingRef, badJson }
    `)
    const exportedPack = packSuite?.exported?.ok ? JSON.parse(packSuite.exported.data.json) : null
    check('分享包：导出 JSON 包含格式标记与指定技能', !!exportedPack && exportedPack.format === 'shopilot-agent-pack' && exportedPack.version === 1 && exportedPack.skills.some(item => item.name === 'Domain 巡检技能') && exportedPack.skills.every(item => !('id' in item) && !('createdAt' in item)), packSuite?.exported?.error?.code || JSON.stringify(exportedPack?.skills?.map(item => item.name) || ''))
    check('分享包：导入必须先经用户确认', packSuite?.unconfirmed?.ok === false && packSuite.unconfirmed.error.code === 'AGENT_CONFIRMATION_REQUIRED', packSuite?.unconfirmed?.error?.code || '')
    check('分享包：包含需确认动作的包整体拒绝（不半导入）', packSuite?.invalid?.ok === false && packSuite.invalid.error.code === 'AGENT_PACK_INVALID', packSuite?.invalid?.error?.code || '')
    check('分享包：导入成功、同名幂等更新、插件一并落库', !!packSuite?.imported?.ok && packSuite.imported.data.importedSkills === 1 && packSuite.imported.data.importedPlugins === 1 && !!packSuite.again?.ok && packSuite.again.data.updatedSkills === 1 && !!packSuite.library?.ok && packSuite.library.data.skills.some(item => item.name === 'Domain 导入技能') && packSuite.library.data.plugins.some(item => item.name === 'Domain 导入插件'), packSuite?.imported?.error?.code || JSON.stringify(packSuite?.imported?.data || ''))
    check('分享包：插件引用缺失技能时如实报错且技能仍导入', !!packSuite?.missingRef?.ok && packSuite.missingRef.data.errors.length === 1 && packSuite.missingRef.data.importedPlugins === 0 && packSuite.missingRef.data.updatedSkills === 1, JSON.stringify(packSuite?.missingRef?.data || ''))
    check('分享包：非法 JSON 被拒绝', packSuite?.badJson?.ok === false && packSuite.badJson.error.code === 'AGENT_PACK_INVALID', packSuite?.badJson?.error?.code || '')
    const inviteSuite = await cdp.eval(`
      const fixtureStoreId = ${JSON.stringify(storeId)}
      const created = await window.shopilot.store.create({ name: 'Domain 邀约店铺', platform: '抖店', adminUrl: ${JSON.stringify(pageUrl)} })
      const inviteStoreId = created.ok ? created.data.id : ''
      const plan = (action) => ({ id: 'plan_' + Math.random().toString(36).slice(2), name: '邀约验收', goal: '邀约验收', steps: [{ id: 'step_' + Math.random().toString(36).slice(2), action, description: '邀约验收', risk: 'write', requiresConfirmation: false }], requiresConfirmation: false, status: 'draft' })
      const unsupported = await window.shopilot.agent.executeSoftwarePlan(plan({ type: 'runInvite', storeId: fixtureStoreId }), true)
      const missingConfig = inviteStoreId ? await window.shopilot.agent.executeSoftwarePlan(plan({ type: 'runInvite', storeId: inviteStoreId }), true) : null
      // 广场地址指到本地只读页，避免验收里访问真实平台
      await window.shopilot.settings.set('invite.squareUrls', { '抖店': ${JSON.stringify(pageUrl)} })
      const seeded = inviteStoreId ? await window.shopilot.settings.set('invite.config.store.' + inviteStoreId, {
        category: '', subcategory: '', category3: '', levels: ['LV0'], count: 2, script: '', scriptMode: 'manual',
        benefits: [], strengths: [], mainCategory: '', extraFilters: {}, batchContact: '张三', batchPhone: '13800138000', batchWechat: 'wx_domain', batchProductCount: 1
      }) : null
      const dispatched = seeded?.ok ? await window.shopilot.agent.executeSoftwarePlan(plan({ type: 'runInvite', storeId: inviteStoreId, count: 2 }), true) : null
      const jobs = await window.shopilot.agentDomain.jobList({ limit: 20 })
      const inviteJob = jobs.ok ? (jobs.data.items || []).find(job => String(job.goal || '').startsWith('达人邀约 · Domain 邀约店铺')) : null
      if (inviteJob) await window.shopilot.agentDomain.jobCancel(inviteJob.id)
      if (inviteStoreId) await window.shopilot.store.deletePermanent(inviteStoreId)
      return { created: created.ok, unsupported, missingConfig, seeded: !!seeded?.ok, dispatched, inviteJob: inviteJob ? { id: inviteJob.id, hasTask: !!inviteJob.browserTaskId } : null }
    `)
    console.log('INVITE_DEBUG', JSON.stringify(inviteSuite?.dispatched?.error || inviteSuite?.dispatched?.data?.messages || ''))
    check('达人邀约：未实测平台明确拒绝（不猜流程）', inviteSuite?.unsupported?.ok === false && inviteSuite.unsupported.error.code === 'AGENT_INVITE_UNSUPPORTED', inviteSuite?.unsupported?.error?.code || '')
    check('达人邀约：配置不完整时明确报错（不猜内容）', inviteSuite?.missingConfig?.ok === false && inviteSuite.missingConfig.error.code === 'AGENT_INVITE_CONFIG_INCOMPLETE', inviteSuite?.missingConfig?.error?.code || '')
    check('达人邀约：按店铺已保存配置派发 Job 并给出回执', !!inviteSuite?.dispatched?.ok && String(inviteSuite.dispatched.data.messages.join('；')).includes('已派发达人邀约') && !!inviteSuite?.inviteJob?.hasTask, inviteSuite?.dispatched?.error ? `${inviteSuite.dispatched.error.code}: ${inviteSuite.dispatched.error.message}` : JSON.stringify(inviteSuite?.inviteJob || ''))
    // Job 载荷嵌套超限时如实报错（旧实现会在第 6 层静默替换成字符串，导致引擎校验失败）
    const tooDeep = childId ? await cdp.eval(`
      let nested = { type: 'readText', input: { selector: 'title' } }
      for (let i = 0; i < 18; i++) nested = { type: 'readText', input: { selector: 'title', extra: nested } }
      return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:${JSON.stringify(storeId)},goal:'过深载荷必须如实拒绝',inputSummary:{source:'local-too-deep-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-too-deep-${Date.now()}',browserTask:{name:'过深载荷',storeScope:${JSON.stringify(storeId)},steps:[nested]}})
    `) : null
    check('Job 载荷嵌套超限时如实拒绝（不静默替换结构）', tooDeep?.ok === false && tooDeep.error.code === 'AGENT_JOB_PAYLOAD_TOO_DEEP', tooDeep?.error?.code || JSON.stringify(tooDeep?.data || ''))
    // 订单明细：未实测平台不猜锚点；登记实测覆盖后整表采集并落行。
    await cdp.eval(`return await window.shopilot.browser.open(${JSON.stringify(storeId)})`).catch(() => null)
    const ordersBefore = await cdp.eval(`return await window.shopilot.agent.generatePlan('查看订单明细')`)
    check('订单明细：未实测平台不猜锚点（如实未派发）', ordersBefore?.ok === true && String(ordersBefore.data.text || '').includes('未派发'), ordersBefore?.error?.code || String(ordersBefore?.data?.text || '').slice(0, 120))
    const ordersSuite = await cdp.eval(`
      const ordersUrl = ${JSON.stringify(pageUrl)}.replace('/read-only', '/orders')
      await window.shopilot.browser.open(${JSON.stringify(storeId)})
      const seeded = await window.shopilot.settings.set('orders.profiles', { '测试平台': {
        platform: '测试平台', pageUrl: ordersUrl, urlMarker: '/orders', measuredAt: '2026-09-25',
        table: { selector: 'table#orders', pickByHeader: '订单号', expectHeaders: ['订单号', '订单状态'] },
        columns: [{ key: 'orderNo', header: '订单号' }, { key: 'status', header: '订单状态' }, { key: 'amount', header: '实付金额' }, { key: 'createdAt', header: '下单时间' }]
      } })
      const readBack = await window.shopilot.settings.get('orders.profiles')
      const ctx = await window.shopilot.agent.softwareContext()
      const planned = await window.shopilot.agent.generatePlan('查看订单明细')
      const jobIds = planned.ok && Array.isArray(planned.data.jobIds) ? planned.data.jobIds : []
      let finished = null
      for (let i = 0; i < 60 && jobIds.length; i++) {
        const job = await window.shopilot.agentDomain.jobGet(jobIds[0])
        if (job.ok && ['succeeded', 'failed', 'cancelled'].includes(job.data.status)) { finished = job.data; break }
        await new Promise(r => setTimeout(r, 1000))
      }
      const results = finished?.browserRunId ? await window.shopilot.task.results(finished.browserRunId) : null
      const table = results?.ok ? (results.data.results || []).find(item => item.kind === 'table') : null
      await window.shopilot.settings.set('orders.profiles', {})
      return { seeded: !!seeded?.ok, readBack: readBack.ok ? Object.keys(readBack.data.value || {}) : readBack.error, displayed: ctx.ok ? ctx.data.displayedStoreId : null, stores: ctx.ok ? ctx.data.stores.map(s => s.name + ':' + s.platform) : [], plannedText: planned.ok ? planned.data.text : JSON.stringify(planned.error), jobIds, status: finished?.status || null, rows: table?.payload?.rows?.length ?? null, metric: table?.payload?.metric ?? null }
    `)
    check('订单明细：按实测档案整表采集并逐行落库', !!ordersSuite?.seeded && ordersSuite.status === 'succeeded' && ordersSuite.rows >= 2 && ordersSuite.metric === 'orders.detail', ordersSuite?.plannedText?.slice(0, 100) || JSON.stringify(ordersSuite || ''))

    const snapshotJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'验证 Job 权限快照不能随 Agent 扩权而改变',inputSummary:{source:'local-permission-snapshot-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-permission-snapshot-${Date.now()}',browserTask:null})`) : null
    const widenedScope = childId ? await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:${JSON.stringify(childId)},confirmed:true,memoryScope:{agentIds:[${JSON.stringify(childId)}],includeShared:true,write:false}})`) : null
    const snapshotRun = snapshotJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(snapshotJob.data.id)})`) : null
    check('permission changes after Job creation invalidate the frozen snapshot', !!widenedScope?.ok && !!snapshotRun?.ok && snapshotRun.data.status === 'blocked_permission' && snapshotRun.data.results.length === 0, snapshotRun?.error?.code || JSON.stringify(snapshotRun?.data || snapshotRun || ''))

    const confirmationJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'发送本地测试消息',inputSummary:{source:'local-confirmation-fixture'},priority:40,requiresConfirmation:true,idempotencyKey:'domain-confirm-${Date.now()}',browserTask:null})`) : null
    const confirmationJobId = confirmationJob?.ok ? confirmationJob.data.id : null
    const confirmationRun = confirmationJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(confirmationJobId)})`) : null
    check('high-risk Job pauses for explicit confirmation', !!confirmationRun?.ok && confirmationRun.data.status === 'waiting_confirmation' && !!confirmationRun.data.confirmationId && !confirmationRun.data.confirmationApproved, confirmationRun?.error?.code || JSON.stringify(confirmationRun?.data || confirmationRun || ''))
    const dependentJob = confirmationJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'等待前置确认 Job 完成',inputSummary:{source:'local-dependency-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-dependency-${Date.now()}',browserTask:null,dependencies:[${JSON.stringify(confirmationJobId)}]})`) : null
    const dependentRun = dependentJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(dependentJob.data.id)})`) : null
    check('Job dependencies block execution until the prerequisite succeeds', dependentRun?.ok === false && dependentRun.error.code === 'AGENT_JOB_DEPENDENCY_WAITING', dependentRun?.error?.code || '')
    const confirmationApproval = confirmationJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobApprove(${JSON.stringify(confirmationJobId)},true,${JSON.stringify(confirmationRun?.data?.confirmationId || '')})`) : null
    check('user confirmation atomically queues the Job once', !!confirmationApproval?.ok && confirmationApproval.data.status === 'queued' && confirmationApproval.data.confirmationApproved === true && confirmationApproval.data.confirmationExpiresAt === null, confirmationApproval?.error?.code || '')
    const confirmationAfterApproval = confirmationJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(confirmationJobId)})`) : null
    check('approved high-risk Job does not re-enter confirmation loop', !!confirmationAfterApproval?.ok && confirmationAfterApproval.data.status === 'blocked_permission' && confirmationAfterApproval.data.confirmationApproved === true, confirmationAfterApproval?.error?.code || JSON.stringify(confirmationAfterApproval?.data || confirmationAfterApproval || ''))

    const modelJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'分析本地只读输入并返回可审核摘要',inputSummary:{source:'local-model-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-model-${Date.now()}',browserTask:null})`) : null
    modelJobId = modelJob?.ok ? modelJob.data.id : null
    const modelRun = modelJobId ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(modelJobId)})`) : null
    const modelResultCount = Array.isArray(modelRun?.data?.results) ? modelRun.data.results.length : -1
    check('model-only Job without a Key is blocked truthfully and never fakes success', !!modelRun?.ok && modelRun.data.status === 'blocked_permission' && modelResultCount === 0, modelRun?.error?.code || JSON.stringify(modelRun?.data || modelRun || ''))
    const runnableProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Runnable Fixture',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-runnable',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const runnableProfileId = runnableProfile?.ok ? runnableProfile.data.id : null
    if (childId && runnableProfileId) await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(runnableProfileId)})`)
    const runnableJob = childId && runnableProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'执行本地模型只读分析',inputSummary:{source:'local-runnable-model-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-runnable-model-${Date.now()}',browserTask:null})`) : null
    const runnableRun = runnableJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(runnableJob.data.id)})`) : null
    check('encrypted Profile Key enables a real local model Job and evidence result', !!runnableRun?.ok && runnableRun.data.status === 'succeeded' && Array.isArray(runnableRun.data.results) && runnableRun.data.results.length > 0 && runnableRun.data.modelSnapshot?.modelProfile?.id === runnableProfileId, runnableRun?.error?.code || JSON.stringify(runnableRun?.data || runnableRun || ''))
    const flakyProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Flaky Fixture',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/flaky`)},model:'fixture-flaky',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const flakyProfileId = flakyProfile?.ok ? flakyProfile.data.id : null
    if (childId && flakyProfileId) await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(flakyProfileId)})`)
    const flakyJob = childId && flakyProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'429 后自动重试一次并完成只读分析',inputSummary:{source:'local-flaky-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-flaky-${Date.now()}',browserTask:null})`) : null
    const flakyRun = flakyJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(flakyJob.data.id)})`) : null
    check('HTTP 429 retries a model Job exactly once and then succeeds', !!flakyRun?.ok && flakyRun.data.status === 'succeeded' && flaky429Count === 1 && flakyRun.data.results.length > 0, flakyRun?.error?.code || JSON.stringify({ status: flakyRun?.data?.status, flaky429Count }))
    const emptyProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Empty Fixture',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/empty`)},model:'fixture-model',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const emptyTest = emptyProfile?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.modelTest(${JSON.stringify(emptyProfile.data.id)})`) : null
    check('model test rejects an empty response with a stable IPC error', emptyTest?.ok === false && emptyTest.error.code === 'AI_EMPTY_OUTPUT', emptyTest?.error?.code || JSON.stringify(emptyTest?.data || emptyTest || ''))
    const invalidProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Invalid Fixture',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/invalid`)},model:'fixture-model',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const invalidTest = invalidProfile?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.modelTest(${JSON.stringify(invalidProfile.data.id)})`) : null
    check('model test classifies malformed JSON separately from empty output', invalidTest?.ok === false && invalidTest.error.code === 'AI_INVALID_JSON', invalidTest?.error?.code || JSON.stringify(invalidTest?.data || invalidTest || ''))

    const probeProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Capability Probe',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/json`)},model:'fixture-json',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const probeTest = probeProfile?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.modelTest(${JSON.stringify(probeProfile.data.id)})`) : null
    const probeList = probeProfile?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.modelList({limit:200})`) : null
    const probedProfile = probeList?.ok ? (probeList.data.items || []).find(item => item.id === probeProfile.data.id) || null : null
    check('capability probe persists structured-JSON capability and healthy profile state', !!probeTest?.ok && probeTest.data.capabilities?.chat === true && probeTest.data.capabilities?.json === true && probedProfile?.health === 'healthy' && probedProfile?.capabilities?.json === true, probeTest?.error?.code || JSON.stringify({ probe: probeTest?.data, stored: probedProfile }))

    const slowProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Slow Fixture',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/slow`)},model:'fixture-model',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const slowProfileId = slowProfile.ok ? slowProfile.data.id : null
    if (childId && slowProfileId) await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(slowProfileId)})`)
    const slowJob = childId && slowProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'取消本地慢模型请求',inputSummary:{source:'local-cancel-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-cancel-${Date.now()}',browserTask:null})`) : null
    const slowJobId = slowJob?.ok ? slowJob.data.id : null
    const cancellation = slowJobId ? await cdp.eval(`const running=window.shopilot.agentDomain.jobRun(${JSON.stringify(slowJobId)}); await new Promise(r=>setTimeout(r,120)); const cancelled=await window.shopilot.agentDomain.jobCancel(${JSON.stringify(slowJobId)}); const completed=await running; const final=await window.shopilot.agentDomain.jobGet(${JSON.stringify(slowJobId)}); return {cancelled,completed,final}`) : null
    check('cancelling a model Job aborts the request without stale result or fallback', !!cancellation?.cancelled?.ok && cancellation.final?.ok && cancellation.final.data.status === 'cancelled' && cancellation.final.data.results.length === 0, cancellation?.final?.data?.status || cancellation?.cancelled?.error?.code || '')
    const orgBeforeQueue = await cdp.eval('return await window.shopilot.agentDomain.orgList({limit:200})')
    const autoExecutor = (orgBeforeQueue?.data?.items || []).find(item => item.name === '执行助手')
    if (autoExecutor) await cdp.eval(`return await window.shopilot.agentDomain.orgPause(${JSON.stringify(autoExecutor.id)},true)`)
    const slowHold = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'占住并发上限的慢模型任务',inputSummary:{source:'local-queue-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-queue-hold-${Date.now()}',browserTask:null})`) : null
    const slowHoldId = slowHold?.ok ? slowHold.data.id : null
    const slowHoldRunning = slowHoldId ? await cdp.eval(`window.shopilot.agentDomain.jobRun(${JSON.stringify(slowHoldId)}); await new Promise(r=>setTimeout(r,150)); return await window.shopilot.agentDomain.jobGet(${JSON.stringify(slowHoldId)})`) : null
    const queuedDelegate = childId && storeId ? await cdp.eval(`return await window.shopilot.agentDomain.jobDelegate({goal:'排队等待执行的只读页面任务',storeId:${JSON.stringify(storeId)},run:true,browserTask:{name:'排队只读任务',steps:[{type:'readText',input:{selector:'title'}}]}})`) : null
    check('执行者并发已满时派单转入排队而不是失败', !!slowHoldRunning?.ok && slowHoldRunning.data.status === 'running' && !!queuedDelegate?.ok && queuedDelegate.data.queued === true && queuedDelegate.data.job.status === 'queued', queuedDelegate?.error?.code || JSON.stringify({ running: slowHoldRunning?.data?.status, queued: queuedDelegate?.data?.queued, status: queuedDelegate?.data?.job?.status }))
    if (slowHoldId) await cdp.eval(`return await window.shopilot.agentDomain.jobCancel(${JSON.stringify(slowHoldId)})`).catch(() => null)
    if (queuedDelegate?.ok) await cdp.eval(`return await window.shopilot.agentDomain.jobCancel(${JSON.stringify(queuedDelegate.data.job.id)})`).catch(() => null)
    if (autoExecutor) await cdp.eval(`return await window.shopilot.agentDomain.orgResume(${JSON.stringify(autoExecutor.id)},true)`).catch(() => null)

    const failingProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Failing Primary',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/fail`)},model:'fixture-failing',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const failingProfileId = failingProfile?.ok ? failingProfile.data.id : null
    const wiredFallback = failingProfileId && runnableProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelSet({id:${JSON.stringify(failingProfileId)},name:'Local Failing Primary',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/fail`)},model:'fixture-failing',timeoutMs:5000,fallbackProfileId:${JSON.stringify(runnableProfileId)}})`) : null
    if (wiredFallback?.ok && childId) await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(failingProfileId)})`)
    const fallbackJob = childId && wiredFallback?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'主模型不可用时按白名单切换本地备用 Profile',inputSummary:{source:'local-fallback-route-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-fallback-route-${Date.now()}',browserTask:null})`) : null
    const fallbackRun = fallbackJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(fallbackJob.data.id)})`) : null
    const fallbackEvidence = fallbackRun?.data?.results?.[0]?.evidence || null
    check('provider-overload job routes to the enabled fallback Profile and records fallbackUsed', !!fallbackRun?.ok && fallbackRun.data.status === 'succeeded' && fallbackRun.data.modelSnapshot?.id === failingProfileId && fallbackEvidence?.fallbackUsed === true && fallbackEvidence?.profileId === runnableProfileId, fallbackRun?.error?.code || JSON.stringify({ status: fallbackRun?.data?.status, evidence: fallbackEvidence, snapshotId: fallbackRun?.data?.modelSnapshot?.id }))

    const unauthorizedProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Unauthorized Primary',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/unauthorized`)},model:'fixture-unauthorized',apiKey:'temporary-agent-cdp-key',timeoutMs:5000})`)
    const unauthorizedProfileId = unauthorizedProfile?.ok ? unauthorizedProfile.data.id : null
    const wiredUnauthorized = unauthorizedProfileId && runnableProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.modelSet({id:${JSON.stringify(unauthorizedProfileId)},name:'Local Unauthorized Primary',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/unauthorized`)},model:'fixture-unauthorized',timeoutMs:5000,fallbackProfileId:${JSON.stringify(runnableProfileId)}})`) : null
    if (wiredUnauthorized?.ok && childId) await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(unauthorizedProfileId)})`)
    const unauthorizedJob = childId && wiredUnauthorized?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'认证失败时禁止降级到备用 Profile',inputSummary:{source:'local-no-fallback-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-no-fallback-${Date.now()}',browserTask:null})`) : null
    const unauthorizedRun = unauthorizedJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(unauthorizedJob.data.id)})`) : null
    const unauthorizedLastEvent = unauthorizedRun?.data?.events?.at(-1) || null
    check('auth failure fails the Job without falling back to the configured fallback Profile', !!unauthorizedRun?.ok && unauthorizedRun.data.status === 'failed' && unauthorizedRun.data.modelSnapshot?.id === unauthorizedProfileId && unauthorizedRun.data.results.length === 0 && unauthorizedLastEvent?.evidence?.code === 'AI_AUTH_FAILED' && !unauthorizedRun.data.events.some(event => event.evidence?.fallbackUsed === true), unauthorizedRun?.error?.code || JSON.stringify({ status: unauthorizedRun?.data?.status, lastEvent: unauthorizedLastEvent, results: unauthorizedRun?.data?.results?.length }))

    const budgetScope = childId ? await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:${JSON.stringify(childId)},confirmed:true,dailyBudget:{currency:'tokens',amount:1}})`) : null
    const budgetJob = childId && budgetScope?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'校验日预算耗尽时阻断模型请求',inputSummary:{source:'local-budget-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-budget-${Date.now()}',browserTask:null})`) : null
    const budgetRun = budgetJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(budgetJob.data.id)})`) : null
    check('daily token budget blocks the job before any model request', !!budgetRun?.ok && budgetRun.data.status === 'blocked_budget' && budgetRun.data.results.length === 0, budgetRun?.error?.code || JSON.stringify({ status: budgetRun?.data?.status, events: budgetRun?.data?.events?.slice(-1) }))

    const unpricedReview = await cdp.eval('return await window.shopilot.agentDomain.qualityReview()')
    check('quality review reports unestimated cost when no provider price is configured', !!unpricedReview?.ok && unpricedReview.data.usage?.costStatus === 'unestimated_without_price' && unpricedReview.data.usage?.estimatedCost === null, unpricedReview?.error?.code || JSON.stringify(unpricedReview?.data?.usage || {}))

    const pricedProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Priced Fixture',provider:'local',endpoint:${JSON.stringify(pageUrl)},model:'fixture-priced',apiKey:'temporary-agent-cdp-key',timeoutMs:5000,pricing:{currency:'USD',inputPerMTok:200000,outputPerMTok:0}})`)
    const pricedProfileId = pricedProfile?.ok ? pricedProfile.data.id : null
    if (childId && pricedProfileId) {
      await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:${JSON.stringify(childId)},confirmed:true,dailyBudget:null})`)
      await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(pricedProfileId)})`)
    }
    const pricedJob = childId && pricedProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'按配置价格估算本地模型成本',inputSummary:{source:'local-pricing-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-pricing-${Date.now()}',browserTask:null})`) : null
    const pricedRun = pricedJob?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.jobRun(${JSON.stringify(pricedJob.data.id)})`) : null
    const pricedEvidence = pricedRun?.data?.results?.[0]?.evidence || null
    const pricedReview = pricedRun?.ok ? await cdp.eval('return await window.shopilot.agentDomain.qualityReview()') : null
    check('configured token price produces a bounded estimated cost and switches costStatus', !!pricedRun?.ok && pricedRun.data.status === 'succeeded' && pricedEvidence?.estimatedCost === 1 && pricedEvidence?.costCurrency === 'USD' && pricedReview?.data?.usage?.costStatus === 'provider_or_configured_cost' && pricedReview?.data?.usage?.estimatedCost === 1, pricedRun?.error?.code || JSON.stringify({ status: pricedRun?.data?.status, evidence: pricedEvidence, usage: pricedReview?.data?.usage }))

    const memory = await cdp.eval(`return await window.shopilot.agentDomain.memoryWrite({agentId:'root-ceo',storeId:null,scope:'shared',type:'semantic',title:'本地验收库存规则',content:'抖店库存低于 10 件时，先读取页面证据再提交给 CEO 审核。',confidence:0.9,sensitivity:'low'})`)
    check('memory write is redacted and starts pending-review', !!memory?.ok && memory.data.status === 'pending-review' && !memory.data.filePath)
    const reviewed = memory?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.memoryReview({memoryId:${JSON.stringify(memory.data.id)},status:'approved',reviewerAgentId:'root-ceo'})`) : null
    const found = memory?.ok ? await cdp.eval(`return await window.shopilot.agentDomain.memorySearch({agentId:'root-ceo',query:'库存规则',limit:10})`) : null
    check('approved memory is searchable through local FTS/keyword fallback', !!reviewed?.ok && !!found?.ok && found.data.some(item => item.id === memory.data.id), found?.error?.code || '')
    const otherStore = await cdp.eval(`return await window.shopilot.store.create({name:'Agent Domain 第二店',platform:'测试平台',adminUrl:${JSON.stringify(pageUrl)}})`)
    otherStoreId = otherStore.ok ? otherStore.data.id : null
    const scopedA = storeId ? await cdp.eval(`return await window.shopilot.agentDomain.memoryWrite({agentId:'root-ceo',storeId:${JSON.stringify(storeId)},scope:'store',type:'semantic',title:'隔离店铺 A',content:'隔离夹具 A 只属于当前店铺。',confidence:0.8,sensitivity:'low'})`) : null
    const scopedB = otherStoreId ? await cdp.eval(`return await window.shopilot.agentDomain.memoryWrite({agentId:'root-ceo',storeId:${JSON.stringify(otherStoreId)},scope:'store',type:'semantic',title:'隔离店铺 B',content:'隔离夹具 B 只属于第二店铺。',confidence:0.8,sensitivity:'low'})`) : null
    const scopedSearch = storeId ? await cdp.eval(`return await window.shopilot.agentDomain.memorySearch({agentId:'root-ceo',storeId:${JSON.stringify(storeId)},query:'隔离夹具',limit:20})`) : null
    check('memory search remains isolated by store scope', !!scopedA?.ok && !!scopedB?.ok && !!scopedSearch?.ok && scopedSearch.data.some(item => item.id === scopedA.data.id) && !scopedSearch.data.some(item => item.id === scopedB.data.id))
    const beforeRebuild = await cdp.eval(`return await window.shopilot.agentDomain.memoryList({agentId:'root-ceo',limit:50})`)
    const rebuilt = await cdp.eval('return await window.shopilot.agentDomain.memoryRebuild()')
    const afterRebuild = await cdp.eval(`return await window.shopilot.agentDomain.memoryList({agentId:'root-ceo',limit:50})`)
    const trackedMemoryIds = [memory?.data?.id, scopedA?.data?.id, scopedB?.data?.id].filter(Boolean)
    const hashesById = rows => Object.fromEntries((rows?.data?.items || []).filter(item => trackedMemoryIds.includes(item.id)).map(item => [item.id, item.contentHash]))
    const beforeHashes = hashesById(beforeRebuild)
    const afterHashes = hashesById(afterRebuild)
    check('memory FTS index rebuild preserves record hashes', !!rebuilt?.ok && Number(rebuilt.data.indexed) >= trackedMemoryIds.length && Number(rebuilt.data.quarantined) === 0 && trackedMemoryIds.every(id => beforeHashes[id] && beforeHashes[id] === afterHashes[id]), rebuilt?.error?.code || JSON.stringify(rebuilt?.data || { beforeHashes, afterHashes }))
    const recoverySnapshot = await cdp.eval('return await window.shopilot.agentDomain.memorySnapshot()')
    const memoryRootPath = path.join(fixtureAppData, 'ShopPilot', 'agent-memory')
    const recoveryManifestPath = path.join(memoryRootPath, 'manifest.json')
    let recoveryReady = false
    let recoveryFilePath = ''
    let recoveryBody = ''
    try {
      const recoveryManifest = JSON.parse(fs.readFileSync(recoveryManifestPath, 'utf8'))
      const recoveryEntry = recoveryManifest.entries.find(entry => entry.id === memory?.data?.id)
      if (recoveryEntry && recoverySnapshot?.ok) {
        recoveryFilePath = path.join(memoryRootPath, recoveryEntry.path)
        recoveryBody = fs.readFileSync(recoveryFilePath, 'utf8')
        fs.writeFileSync(recoveryFilePath, `${recoveryBody}\n损坏夹具：正文已被篡改。`, 'utf8')
        recoveryReady = true
      }
    } catch {}
    const corruptedRebuild = recoveryReady ? await cdp.eval('return await window.shopilot.agentDomain.memoryRebuild()') : null
    const quarantined = recoveryReady ? await cdp.eval(`return await window.shopilot.agentDomain.memoryList({agentId:'root-ceo',status:'quarantined',limit:50})`) : null
    const restoredCorruption = recoveryReady ? await cdp.eval(`return await window.shopilot.agentDomain.memorySnapshotRestore(${JSON.stringify(recoverySnapshot.data.path)},true)`) : null
    const conflictRows = recoveryReady ? await cdp.eval(`return await window.shopilot.agentDomain.memoryList({agentId:'root-ceo',status:'conflict',limit:50})`) : null
    if (recoveryFilePath && recoveryBody) {
      try { fs.writeFileSync(recoveryFilePath, recoveryBody, 'utf8') } catch {}
      await cdp.eval('return await window.shopilot.agentDomain.memoryRebuild()').catch(() => null)
    }
    check('corrupted memory can be recovered as a conflict version without silent overwrite', recoveryReady && !!corruptedRebuild?.ok && Number(corruptedRebuild.data.quarantined) >= 1 && !!quarantined?.ok && quarantined.data.items.some(item => item.id === memory?.data?.id) && !!restoredCorruption?.ok && Number(restoredCorruption.data.conflicts) >= 1 && !!conflictRows?.ok && conflictRows.data.items.some(item => item.status === 'conflict'), restoredCorruption?.error?.code || JSON.stringify({ corruptedRebuild: corruptedRebuild?.data, quarantined: quarantined?.data, restored: restoredCorruption?.data, conflicts: conflictRows?.data }))
    const qualityReview = await cdp.eval('return await window.shopilot.agentDomain.qualityReview()')
    check('CEO periodic review summary is sourced and cost-honest', !!qualityReview?.ok && Array.isArray(qualityReview.data.sources) && qualityReview.data.sources.includes('agent_jobs') && qualityReview.data.sources.includes('agent_feedback') && ['unestimated_without_price', 'provider_or_configured_cost', 'mixed_currency'].includes(qualityReview.data.usage?.costStatus), qualityReview?.error?.code || JSON.stringify(qualityReview?.data || qualityReview || ''))

    const snapshot = await cdp.eval('return await window.shopilot.agentDomain.memorySnapshot()')
    if (snapshot?.ok) {
      const inspected = await cdp.eval(`return await window.shopilot.agentDomain.memorySnapshotInspect(${JSON.stringify(snapshot.data.path)})`)
      optional('encrypted memory snapshot can be decrypted and inspected in Main', inspected?.ok ? 'passed' : 'failed', inspected?.error?.code || JSON.stringify(inspected?.data || ''))
      const outside = path.resolve(userData, '..', 'shopilot-memory-outside.bin')
      const escaped = await cdp.eval(`return await window.shopilot.agentDomain.memorySnapshotInspect(${JSON.stringify(outside)})`)
      optional('memory snapshot path escape is rejected', escaped?.ok === false && escaped.error.code === 'AGENT_MEMORY_PATH_INVALID' ? 'passed' : 'failed', escaped?.error?.code || '')
      const symlinkPath = path.join(path.dirname(snapshot.data.path), `snapshot-link-${Date.now()}.bin`)
      try {
        fs.symlinkSync(snapshot.data.path, symlinkPath, 'file')
        const linked = await cdp.eval(`return await window.shopilot.agentDomain.memorySnapshotInspect(${JSON.stringify(symlinkPath)})`)
        optional('memory snapshot symlink path is rejected', linked?.ok === false && linked.error.code === 'AGENT_MEMORY_PATH_INVALID' ? 'passed' : 'failed', linked?.error?.code || '')
        try { fs.unlinkSync(symlinkPath) } catch {}
      } catch (error) {
        optional('memory snapshot symlink path is rejected', 'untested', error?.code || 'symlink creation unavailable')
      }
    } else {
      optional('encrypted memory snapshot can be decrypted and inspected in Main', 'untested', snapshot?.error?.code || 'snapshot unavailable in this runtime')
    }

    // 聊天日预算硬阻断：给 root-ceo 设 0 token 日预算 → 对话被 AGENT_BUDGET_BLOCKED 拦截；恢复后放行。
    await cdp.eval(`return await window.shopilot.ai.setKey('temporary-agent-cdp-budget-key')`).catch(() => null)
    const budgetSet = await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:'root-ceo',confirmed:true,dailyBudget:{currency:'tokens',amount:0}})`)
    const budgetBlockedChat = budgetSet?.ok ? await cdp.eval(`return await window.shopilot.agent.generatePlan('你好，今天过得怎么样？')`) : null
    check('聊天/回合受日预算硬阻断（tokens 口径）', budgetSet?.ok === true && budgetBlockedChat?.ok === false && budgetBlockedChat.error.code === 'AGENT_BUDGET_BLOCKED', budgetBlockedChat?.error?.code || JSON.stringify(budgetBlockedChat?.data || ''))
    const budgetRestored = await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:'root-ceo',confirmed:true,dailyBudget:null})`)
    const chatAfterRestore = budgetRestored?.ok ? await cdp.eval(`return await window.shopilot.agent.generatePlan('你好')`) : null
    check('恢复日预算后聊天恢复可用', budgetRestored?.ok === true && chatAfterRestore?.ok === true, chatAfterRestore?.error?.code || JSON.stringify(chatAfterRestore?.data?.kind || ''))

    // Prepare a real in-flight Main-only model request, then kill the process.
    // Startup recovery must mark it recovery_required; it must not fabricate a
    // result, and the user must be able to safely re-queue it.
    const hangProfile = await cdp.eval(`return await window.shopilot.agentDomain.modelSet({name:'Local Hang Fixture',provider:'local',endpoint:${JSON.stringify(`${pageUrl}/hang`)},model:'fixture-hang',apiKey:'temporary-agent-cdp-key',timeoutMs:60000})`)
    const hangProfileId = hangProfile?.ok ? hangProfile.data.id : null
    if (childId && hangProfileId) {
      await cdp.eval(`return await window.shopilot.agentDomain.orgUpdate({actorAgentId:'root-ceo',agentId:${JSON.stringify(childId)},confirmed:true,dailyBudget:null})`)
      await cdp.eval(`return await window.shopilot.agentDomain.modelBind(${JSON.stringify(childId)},${JSON.stringify(hangProfileId)})`)
    }
    const hangJob = childId && hangProfileId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'校验进程中断后的 Job 恢复而不是伪造完成',inputSummary:{source:'local-recovery-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-recovery-${Date.now()}',browserTask:null})`) : null
    const hangJobId = hangJob?.ok ? hangJob.data.id : null
    const hangRunning = hangJobId ? await cdp.eval(`window.shopilot.agentDomain.jobRun(${JSON.stringify(hangJobId)}); await new Promise(r=>setTimeout(r,150)); return await window.shopilot.agentDomain.jobGet(${JSON.stringify(hangJobId)})`) : null
    check('in-flight Main-only model Job is running before the process is killed', !!hangRunning?.ok && hangRunning.data.status === 'running' && hangRunning.data.results.length === 0, hangRunning?.error?.code || JSON.stringify(hangRunning?.data?.status || hangRunning || ''))

    // Restart the real Main process with the same userData and verify that
    // memory metadata and the FTS index are usable after process recovery.
    cdp.close()
    if (appProcess?.pid) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    await waitFor(async () => !(await fetch(`http://127.0.0.1:${PORT}/json/version`).then(res => res.ok).catch(() => false)), 10000)
    appProcess = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: fixtureAppData, LOCALAPPDATA: fixtureAppData, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
    appProcess.stdout.on('data', chunk => { logs += chunk.toString() })
    appProcess.stderr.on('data', chunk => { logs += chunk.toString() })
    await waitFor(async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(res => res.ok).catch(() => false), 30000)
    const restartedTargets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const restartedTarget = restartedTargets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    cdp = restartedTarget ? new CDP(restartedTarget.webSocketDebuggerUrl) : null
    const restartedReady = !!cdp && await waitFor(async () => cdp.eval('return !!window.shopilot').catch(() => false), 15000)
    const restartedSearch = restartedReady && scopedA?.data?.id ? await cdp.eval(`return await window.shopilot.agentDomain.memorySearch({agentId:'root-ceo',query:'隔离夹具',limit:20})`) : null
    check('memory remains searchable after restarting the Main process', restartedReady && !!restartedSearch?.ok && restartedSearch.data.some(item => item.id === scopedA.data.id), restartedSearch?.error?.code || JSON.stringify(restartedSearch?.data || restartedSearch || ''))
    const recoveredJob = hangJobId && restartedReady ? await cdp.eval(`return await window.shopilot.agentDomain.jobGet(${JSON.stringify(hangJobId)})`) : null
    check('startup marks the interrupted Job recovery_required without fabricating a result', !!recoveredJob?.ok && recoveredJob.data.status === 'recovery_required' && recoveredJob.data.results.length === 0, recoveredJob?.error?.code || JSON.stringify(recoveredJob?.data?.status || recoveredJob || ''))
    const recoveredRun = hangJobId && restartedReady ? await cdp.eval(`return await window.shopilot.agentDomain.jobResume(${JSON.stringify(hangJobId)})`) : null
    check('a recovery_required Job can be safely re-queued after restart', !!recoveredRun?.ok && recoveredRun.data.status === 'queued', recoveredRun?.error?.code || JSON.stringify(recoveredRun?.data?.status || recoveredRun || ''))
    const pausedChild = childId ? await cdp.eval(`return await window.shopilot.agentDomain.orgPause(${JSON.stringify(childId)},true)`) : null
    const pausedJob = childId ? await cdp.eval(`return await window.shopilot.agentDomain.jobCreate({createdByAgentId:'root-ceo',assignedAgentId:${JSON.stringify(childId)},storeId:null,goal:'暂停状态不得接收新 Job',inputSummary:{source:'local-paused-fixture'},priority:40,requiresConfirmation:false,idempotencyKey:'domain-paused-${Date.now()}',browserTask:null})`) : null
    const resumedChild = childId ? await cdp.eval(`return await window.shopilot.agentDomain.orgResume(${JSON.stringify(childId)},true)`) : null
    check('paused Agent cannot receive new Jobs and resumes cleanly', !!pausedChild?.ok && pausedChild.data.status === 'paused' && pausedJob?.ok === false && pausedJob.error.code === 'AGENT_PERMISSION_DENIED' && !!resumedChild?.ok && resumedChild.data.status === 'active', pausedJob?.error?.code || JSON.stringify({ paused: pausedChild?.data?.status, resumed: resumedChild?.data?.status }))

    if (browserJobId) await cdp.eval(`return await window.shopilot.agentDomain.jobCancel(${JSON.stringify(browserJobId)})`).catch(() => null)
    if (storeId) { await cdp.eval(`return await window.shopilot.browser.close(${JSON.stringify(storeId)})`).catch(() => null); await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(storeId)})`).catch(() => null) }
    if (otherStoreId) await cdp.eval(`return await window.shopilot.store.deletePermanent(${JSON.stringify(otherStoreId)})`).catch(() => null)
    if (childId) await cdp.eval(`return await window.shopilot.agentDomain.orgRetire(${JSON.stringify(childId)},true)`).catch(() => null)
    report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'cdp-report.json'), JSON.stringify({ ...report, note: 'local read-only fixture; no real store or paid model call' }, null, 2))
    if (logs.includes('temporary-agent-cdp-key')) throw new Error('sensitive test key appeared in Main logs')
  } catch (error) {
    report.status = 'failed'; report.error = String(error?.stack || error); report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'agent'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'agent', 'cdp-report.json'), JSON.stringify(report, null, 2))
    console.error('AGENT_DOMAIN_CDP_FAIL', error?.stack || error)
  } finally {
    cdp?.close(); if (server) await new Promise(resolve => server.close(resolve));
    if (appProcess && appProcess.exitCode == null) { try { execSync(`taskkill /PID ${appProcess.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    await sleep(600); try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
  const failed = report.checks.filter(item => !item.passed)
  console.log(`Agent domain CDP: ${report.status}; ${report.checks.length - failed.length}/${report.checks.length}`)
  process.exitCode = report.status === 'passed' ? 0 : 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
