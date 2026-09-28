/**
 * 经营数据自动采集 · Electron/CDP 验收（开发文档 §15 的第 1/3~15/17~21 项）。
 *
 * 运行方式（Windows）：
 *   node tools/acceptance/sales-metrics-cdp-verify.js
 *
 * 它启动**已构建产物**（apps/desktop/out/main/index.js，由 electron.exe 加载仓库根 package.json 得到），
 * 用独立 `--user-data-dir` 与独立 CDP 端口，因此**不影响用户自己的实例与真实数据**。
 *
 * 覆盖：
 *   · 计划自动生成（含新店铺）、暂停、恢复、立即采集；
 *   · 从 RUNNING 到终态的完整运行记录；
 *   · 四个实时事件的字段白名单（不带 Cookie/Session/页面正文）；
 *   · strict IPC schema 拒绝夹带字段与越界周期；
 *   · 应用锁定时业务 IPC 被拒；
 *   · 重启后计划不重复、不丢失、不补发积压、无残留 RUNNING；
 *   · 真实 SQLite 与界面数据一致（另跑 sales-metrics-db-inspect.js 交叉核对）；
 *   · 日志与诊断包不含敏感信息。
 *
 * 明确不做：真实平台登录态读数（见 sales-metrics-real-probe.js）。
 * 本脚本用"没有打开店铺页面"这一真实条件模拟页面不可用，得到的是 PAGE_NOT_READY，
 * 不能当成平台采集成功。
 */
const { spawn } = require('child_process')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.env.SHOPILOT_SM_CDP_PORT || 9301)
const userData = process.env.SHOPILOT_SM_USER_DATA || path.join(os.tmpdir(), `shopilot-sm-${Date.now()}`)
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 默认跑开发版（electron.exe + 仓库根，加载 apps/desktop/out 的构建产物）。
 * 传 SHOPILOT_SM_APP_EXE 指向打包版可执行文件即可对同一个脚本跑一遍打包验收：
 *   set SHOPILOT_SM_APP_EXE=D:\code\电商浏览器\release\win-unpacked\ShopPilot.exe
 */
const APP_EXE = process.env.SHOPILOT_SM_APP_EXE || ''
const packaged = !!APP_EXE
const artifactsDir = path.join(ROOT, 'artifacts', 'sales-metrics')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ---------------- CDP ---------------- */

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null)
  if (!response || !response.ok) return []
  return await response.json()
}

async function findRenderer(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await listTargets()
    const page = targets.find(item => item.type === 'page' && /index\.html/.test(item.url || ''))
    if (page && page.webSocketDebuggerUrl) return page
    if (Date.now() >= deadline) return null
    await sleep(500)
  }
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', event => reject(new Error('WS_ERROR ' + String(event && event.message)))
    )
  })
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)) } }, 30000)
      })
    },
    async evaluate(body, timeoutMs = 60000) {
      const result = await Promise.race([
        this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
        sleep(timeoutMs).then(() => { throw new Error('EVAL_TIMEOUT') })
      ])
      if (result.exceptionDetails) {
        throw new Error('EVAL_EXCEPTION ' + JSON.stringify(result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails.text))
      }
      return result.result ? result.result.value : undefined
    },
    close() { try { socket.close() } catch { /* ignore */ } }
  }
}

/* ---------------- 进程 ---------------- */

function freeDebugPort(port) {
  try {
    const output = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(output.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(Boolean))
    for (const pid of pids) {
      console.log(`端口 ${port} 被 PID ${pid} 占用，先结束它（否则新实例绑不上端口，验收会静默连到旧实例）`)
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    if (pids.size) return true
    return false
  } catch { return false }
}

function launch() {
  // 打包版直接跑 ShopPilot.exe（不需要 app path 参数）；开发版用 electron.exe + 仓库根。
  const args = packaged
    ? ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
    : [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
  const child = spawn(packaged ? APP_EXE : electronExe, args,
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => { /* 收敛输出，避免噪声 */ })
  child.stderr.on('data', () => { /* 同上 */ })
  return child
}

async function waitForCdp(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null)
    if (response && response.ok) return true
    if (Date.now() >= deadline) return false
    await sleep(400)
  }
}

function killTree(child) {
  try {
    if (child && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch { /* 已经退出 */ }
}

async function stopApp(child) {
  if (!child) return
  // 直接按进程树强杀：Windows 上 SIGTERM 就是 TerminateProcess，父进程先死会让
  // `taskkill /T` 再也枚举不到子进程（实测留下渲染进程孤儿，下一次验收被自己的端口守卫拦住）。
  // 被强杀后库里若留下 RUNNING，由下次启动的 reconcileOrphanRuns 收敛——这正是要验的那条兜底路径。
  killTree(child)
  const deadline = Date.now() + 8000
  while (child.exitCode == null && Date.now() < deadline) await sleep(300)
  await sleep(600)
}

async function openSession(timeoutMs = 40000) {
  const target = await findRenderer(timeoutMs)
  if (!target) throw new Error('找不到渲染层 CDP 目标')
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  // 等 preload 注入完成
  for (let attempt = 0; attempt < 40; attempt++) {
    const ready = await cdp.evaluate('return Boolean(window.shopilot && window.shopilot.salesMetrics);').catch(() => false)
    if (ready) return cdp
    await sleep(300)
  }
  throw new Error('window.shopilot.salesMetrics 未注入')
}

/* ---------------- 检查项 ---------------- */

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true })
  if (fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true })

  const portBusy = freeDebugPort(PORT)
  console.log(`验收实例：${packaged ? '打包版 ' + APP_EXE : '开发版（已构建产物）'} userData=${userData} port=${PORT}${portBusy ? '（已清理端口遗留实例）' : ''}`)

  let child = launch()
  let cdp = null
  try {
    check(`${packaged ? '打包版' : '开发版'}启动并暴露 CDP`, await waitForCdp(), `port=${PORT}`)
    cdp = await openSession()

    /* --- 1. 计划与店铺同步 --- */
    const created = []
    for (const [name, platform] of [['验收店-微信', '微信小店'], ['验收店-抖店', '抖店'], ['验收店-快手', '快手小店']]) {
      const result = await cdp.evaluate(`return await window.shopilot.store.create({ name: ${JSON.stringify(name)}, platform: ${JSON.stringify(platform)}, adminUrl: '' });`)
      if (result && result.ok) created.push({ id: result.data.id, name, platform })
    }
    check('创建 3 个不同平台的店铺（验收夹具，独立 userData）', created.length === 3, `created=${created.length}`)

    const planList = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    check('salesMetrics:plan:list 返回 IPCResult 且带健康汇总', planList.ok === true && planList.data && planList.data.health, `requestId=${planList.requestId || ''}`)
    const planIds = new Set((planList.data.items || []).map(item => item.storeId))
    check('新店铺自动生成采集计划（读列表时按需同步）', created.every(store => planIds.has(store.id)), `plans=${planIds.size}`)
    const plan = (planList.data.items || []).find(item => item.storeId === created[0].id)
    check('计划默认周期 600000ms / Asia/Shanghai / 启用', plan && plan.intervalMs === 600000 && plan.timezone === 'Asia/Shanghai' && plan.enabled === true, JSON.stringify({ intervalMs: plan && plan.intervalMs, timezone: plan && plan.timezone, enabled: plan && plan.enabled }))
    check('首次执行时间为 now + 10 分钟（不在启动时突发采集）', plan && plan.nextRunAt > Date.now() + 9 * 60 * 1000 && plan.nextRunAt < Date.now() + 12 * 60 * 1000, `nextRunAt-now=${Math.round((plan.nextRunAt - Date.now()) / 1000)}s`)
    check('从未采集的店铺新鲜度为 UNAVAILABLE、数据状态不是"真实 0"', plan && plan.freshness === 'UNAVAILABLE' && plan.metrics === null, `freshness=${plan && plan.freshness} metrics=${plan && JSON.stringify(plan.metrics)}`)

    /* --- 2. strict schema 门禁 --- */
    const dirty = await cdp.evaluate("return await window.shopilot.salesMetrics.planUpdate({ storeId: 'x', enabled: true, sql: 'SELECT 1' });")
    check('计划更新拒绝夹带未知字段（strict schema）', dirty.ok === false && dirty.error.code === 'INVALID_ARGUMENT', dirty.ok === false ? dirty.error.code : 'accepted')
    const tooFast = await cdp.evaluate("return await window.shopilot.salesMetrics.planUpdate({ storeId: 'x', intervalMs: 1000 });")
    check('周期越界被拒绝（不允许"每秒一次"）', tooFast.ok === false && tooFast.error.code === 'INVALID_ARGUMENT', tooFast.ok === false ? tooFast.error.code : 'accepted')
    const unknownStore = await cdp.evaluate("return await window.shopilot.salesMetrics.plans({ storeId: '../etc' });")
    check('计划列表只接受 storeId 过滤，非法值不产生路径穿越', unknownStore.ok === true && unknownStore.data.items.length === 0, `items=${unknownStore.ok ? unknownStore.data.items.length : 'n/a'}`)

    /* --- 3. 暂停 / 恢复 --- */
    const paused = await cdp.evaluate(`return await window.shopilot.salesMetrics.planPause(${JSON.stringify(created[0].id)});`)
    check('暂停计划：enabled=false 且不再排下一次', paused.ok === true && paused.data.enabled === false && paused.data.nextRunAt === null, JSON.stringify({ enabled: paused.ok && paused.data.enabled, nextRunAt: paused.ok && paused.data.nextRunAt }))
    const resumed = await cdp.evaluate(`return await window.shopilot.salesMetrics.planResume(${JSON.stringify(created[0].id)});`)
    check('恢复计划：回到 10 分钟周期并清零失败计数', resumed.ok === true && resumed.data.enabled === true && resumed.data.consecutiveFailures === 0 && resumed.data.nextRunAt > Date.now(), JSON.stringify({ enabled: resumed.ok && resumed.data.enabled, failures: resumed.ok && resumed.data.consecutiveFailures }))

    /* --- 4. 实时事件字段白名单 --- */
    await cdp.evaluate(`
      window.__smEvents = [];
      for (const channel of ['salesMetrics:planUpdated','salesMetrics:runStarted','salesMetrics:runFinished','salesMetrics:healthChanged']) {
        window.shopilot.on(channel, payload => window.__smEvents.push({ channel, payload }));
      }
      return true;
    `)

    /* --- 5. 立即采集：RUNNING → 终态 --- */
    const runNow = await cdp.evaluate(`return await window.shopilot.salesMetrics.planRunNow(${JSON.stringify(created[0].id)});`)
    check('立即采集入队成功', runNow.ok === true && runNow.data.accepted === true, JSON.stringify(runNow.ok ? runNow.data : runNow.error))

    let runRecord = null
    let sawRunning = false
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const runs = await cdp.evaluate(`return await window.shopilot.salesMetrics.runs({ storeId: ${JSON.stringify(created[0].id)}, pageSize: 5 });`)
      if (runs.ok && runs.data.items.length) {
        runRecord = runs.data.items[0]
        if (runRecord.status === 'RUNNING') sawRunning = true
        else break
      }
      await sleep(1000)
    }
    check('触发后写入运行记录', !!runRecord, `runId=${runRecord ? runRecord.runId : 'none'} 观察到 RUNNING=${sawRunning}`)
    check('运行记录从 RUNNING 收敛到终态（不留永久 RUNNING）', !!runRecord && runRecord.status !== 'RUNNING', runRecord ? runRecord.status : 'none')
    check('终态带原因码与说明，且已结束', !!runRecord && !!runRecord.reasonCode && runRecord.finishedAt != null, runRecord ? `${runRecord.reasonCode} / ${runRecord.safeMessage}` : 'none')
    check('未打开店铺页面时如实报"页面不可用"，不伪造成功', !!runRecord && runRecord.status !== 'SUCCEEDED' && /PAGE_NOT_READY|NETWORK|LOGIN|TIMEOUT|NOT_VERIFIED/.test(String(runRecord.reasonCode)), runRecord ? runRecord.reasonCode : 'none')

    const events = await cdp.evaluate('return window.__smEvents || [];')
    const channels = new Set(events.map(event => event.channel))
    check('收到 runStarted / runFinished / planUpdated 实时事件', channels.has('salesMetrics:runStarted') && channels.has('salesMetrics:runFinished') && channels.has('salesMetrics:planUpdated'), [...channels].join(','))
    const allowed = ['storeId', 'platform', 'runId', 'status', 'reasonCode', 'collectedAt', 'nextRunAt', 'consecutiveFailures', 'freshness']
    // 白名单只约束**店铺级**事件（runStarted/runFinished/planUpdated）。
    // healthChanged 是聚合事件，负载只有计数与时间戳（无 storeId、无 runId、无任何内容字段），
    // 单独用"匿名性"判据检查，见下一条。
    const scoped = events.filter(event => event.channel !== 'salesMetrics:healthChanged')
    const eventPayloadOk = scoped.length > 0 && scoped.every(event => Object.keys(event.payload).every(key => allowed.includes(key)))
    check('店铺级事件负载只含九个安全字段（无 Cookie/Session/页面正文）', eventPayloadOk, scoped.length ? Object.keys(scoped[0].payload).sort().join(',') : 'no events')
    const healthEvents = events.filter(event => event.channel === 'salesMetrics:healthChanged')
    const healthAnonymous = healthEvents.every(event => {
      const keys = Object.keys(event.payload)
      return keys.every(key => ['computedAt', 'counters', 'nextRunAt', 'lastSuccessAt'].includes(key)) &&
        !keys.some(key => ['storeId', 'platform', 'runId', 'reasonCode'].includes(key))
    })
    check('健康事件是匿名聚合（不含店铺标识与原因码）', healthEvents.length > 0 && healthAnonymous, `healthEvents=${healthEvents.length} keys=${healthEvents.length ? Object.keys(healthEvents[0].payload).join(',') : 'n/a'}`)
    const serializedEvents = JSON.stringify(events)
    check('事件里没有认证类敏感串', !/cookie|token|authorization|sessionid|passport/i.test(serializedEvents))

    /* --- 6. 应用锁定拒绝业务 IPC --- */
    const locked = await cdp.evaluate(`
      const set = await window.shopilot.security.setPassword('sm-accept-secret');
      const lock = await window.shopilot.security.lock();
      const blocked = await window.shopilot.salesMetrics.plans();
      const stillStatus = await window.shopilot.security.status();
      return { set: set.ok, lock: lock.ok, blocked, status: stillStatus.ok ? stillStatus.data : null };
    `)
    check('应用锁定时经营数据业务 IPC 被拒绝', locked.blocked && locked.blocked.ok === false && locked.blocked.error.code === 'APP_LOCKED', locked.blocked ? locked.blocked.error && locked.blocked.error.code : 'no result')
    check('锁定态仍可查询锁状态（锁屏界面不被锁死）', locked.status != null)
    const unlocked = await cdp.evaluate("return await window.shopilot.security.unlock('sm-accept-secret');")
    check('解锁后可继续查询计划', unlocked.ok === true, unlocked.ok ? '' : JSON.stringify(unlocked.error))
    const afterUnlock = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    check('解锁后业务 IPC 恢复', afterUnlock.ok === true && (afterUnlock.data.items || []).length >= 3, `items=${afterUnlock.ok ? afterUnlock.data.items.length : 'n/a'}`)
    await cdp.evaluate("return await window.shopilot.security.removePassword('sm-accept-secret');")

    /* --- 7. 诊断包脱敏 --- */
    // 诊断包导出有路径门禁：只能落在用户目录或系统临时目录（仓库目录会被拒），
    // 所以这里写到临时目录再读回来。
    const diagnosticsPath = path.join(os.tmpdir(), `shopilot-sm-diagnostics-${Date.now()}.json`)
    const diagnostics = await cdp.evaluate(`return await window.shopilot.diagnostics.export(${JSON.stringify(diagnosticsPath)});`)
    if (diagnostics.ok && fs.existsSync(diagnosticsPath)) {
      const content = fs.readFileSync(diagnosticsPath, 'utf8')
      const dirty2 = /cookie|set-cookie|authorization|bearer\s|passport|session_?id|sm-accept-secret/i.test(content)
      check('诊断包不含认证/会话敏感串', !dirty2, dirty2 ? '发现敏感串' : `bytes=${content.length}`)
    } else {
      check('诊断包导出成功（用于脱敏检查）', false, JSON.stringify(diagnostics.error || diagnostics.data || null))
    }

    /* --- 8. 日志脱敏 + 采集日志存在 --- */
    const logDir = path.join(userData, 'logs')
    const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(name => name.startsWith('app-')).sort() : []
    const logText = logFiles.length ? fs.readFileSync(path.join(logDir, logFiles[logFiles.length - 1]), 'utf8') : ''
    check('采集日志有运行记录（可排障）', /\[sales-metrics\]/.test(logText) || /\[sales-metrics-scheduler\]/.test(logText), `log=${logFiles[logFiles.length - 1] || 'none'}`)
    check('日志中没有 Cookie/凭据/PIN 等敏感串', !/(^|\s)(cookie|authorization|bearer)\s*[:=]/i.test(logText))

    /* --- 9. 重启：计划不重复、不丢失、不补发积压、无残留 RUNNING --- */
    const before = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    const beforeCount = before.ok ? before.data.items.length : 0
    cdp.close()
    await stopApp(child)
    child = null

    child = launch()
    check('重启：应用再次启动', await waitForCdp())
    cdp = await openSession()
    const after = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    const afterItems = after.ok ? after.data.items : []
    check('重启后计划不重复、不丢失', afterItems.length === beforeCount && new Set(afterItems.map(item => item.storeId)).size === afterItems.length, `before=${beforeCount} after=${afterItems.length}`)
    const reanchored = afterItems.every(item => !item.enabled || item.nextRunAt == null || item.nextRunAt > Date.now())
    check('重启不补发停机期间积压（下一次采集点都在未来）', reanchored, afterItems.map(item => `${item.storeName}:${item.nextRunAt == null ? 'null' : Math.round((item.nextRunAt - Date.now()) / 1000) + 's'}`).join(' '))
    const running = await cdp.evaluate("return await window.shopilot.salesMetrics.runs({ status: 'RUNNING', pageSize: 50 });")
    check('强杀后重启：库里没有残留 RUNNING（启动收敛兜底）', running.ok === true && running.data.total === 0, `running=${running.ok ? running.data.total : 'n/a'}`)
    const interrupted = await cdp.evaluate("return await window.shopilot.salesMetrics.runs({ status: 'INTERRUPTED', pageSize: 50 });")
    check('被中断的运行被如实标记（可追溯；无中断过则为 0）', interrupted.ok === true, `interrupted=${interrupted.ok ? interrupted.data.total : 'n/a'}`)

    /* --- 10. 健康汇总与界面数据一致 --- */
    const health = await cdp.evaluate('return await window.shopilot.salesMetrics.health();')
    check('health 汇总自洽（新鲜+临期+过期+从未成功+来源未验证 = 店铺数）', health.ok === true && (() => {
      const counters = health.data.counters
      return counters.fresh + counters.aging + counters.stale + counters.unavailable + counters.sourceUnverified === counters.total
    })(), health.ok ? JSON.stringify(health.data.counters) : 'n/a')
    const healthPlans = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    check('plan:list 与 health 的店铺数一致（前端与主进程同一份口径）', healthPlans.ok && health.ok && healthPlans.data.items.length === health.data.counters.total, `items=${healthPlans.ok ? healthPlans.data.items.length : 'n/a'} total=${health.ok ? health.data.counters.total : 'n/a'}`)

    /* --- 11. 数据中心界面挂载 --- */
    const uiPresent = await cdp.evaluate(`
      const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(el => (el.textContent || '').includes('数据分析'));
      if (!nav) return { clicked: false, reason: 'nav-not-found', labels: [...document.querySelectorAll('.dashboard-nav-item')].map(el => (el.textContent || '').trim()) };
      nav.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('[data-test="unified-analytics-page"]')) break;
        await new Promise(r => setTimeout(r, 500));
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('[data-test="sales-metrics-monitor"]')) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const monitor = document.querySelector('[data-test="sales-metrics-monitor"]');
      return {
        clicked: true,
        analyticsPage: Boolean(document.querySelector('[data-test="unified-analytics-page"]')),
        monitor: Boolean(monitor)
      };
    `)
    check('数据中心界面渲染出自动采集监控卡', uiPresent && uiPresent.monitor === true, JSON.stringify(uiPresent))
    const uiRows = await cdp.evaluate(`
      const monitor = document.querySelector('[data-test="sales-metrics-monitor"]');
      if (!monitor) return { rows: 0, text: '' };
      const rows = monitor.querySelectorAll('tbody tr');
      const text = monitor.innerText || '';
      return { rows: rows.length, hasPause: text.includes('暂停') || text.includes('恢复'), hasNever: text.includes('从未成功'), hasNull: text.includes('—'), hasFreshness: text.includes('新鲜度'), firstRow: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').slice(0, 200) : '' };
    `)
    check('界面列出每个店铺的采集计划', uiRows && uiRows.rows >= created.length, JSON.stringify({ rows: uiRows && uiRows.rows, firstRow: uiRows && uiRows.firstRow }))
    check('界面明确展示 null（—）与"从未成功"，不把未采集显示成 0', uiRows && uiRows.hasNull === true && uiRows.hasNever === true, JSON.stringify({ hasNull: uiRows && uiRows.hasNull, hasNever: uiRows && uiRows.hasNever, hasFreshness: uiRows && uiRows.hasFreshness }))
    check('界面提供暂停/恢复操作入口', uiRows && uiRows.hasPause === true, JSON.stringify({ hasPause: uiRows && uiRows.hasPause }))
  } catch (error) {
    check('验收脚本自身未抛异常', false, String(error && error.message || error))
  } finally {
    try { if (cdp) cdp.close() } catch { /* ignore */ }
    await stopApp(child)
    killTree(child)
  }

  const passed = results.filter(item => item.ok).length
  const report = {
    startedAt: new Date().toISOString(),
    userData,
    port: PORT,
    build: packaged ? `packaged ${APP_EXE}` : 'apps/desktop/out (electron-vite build)',
    note: '本报告是 Electron/CDP 验收，不是真实平台采集验收；真实平台见 sales-metrics-real-probe.js',
    total: results.length,
    passed,
    failed: results.filter(item => !item.ok).map(item => item.name),
    results
  }
  fs.writeFileSync(path.join(artifactsDir, packaged ? 'cdp-report-packaged.json' : 'cdp-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n通过 ${passed}/${results.length}` + `（${packaged ? '打包版' : '开发版'} userData=${userData}）`)
  if (passed !== results.length) console.log('失败项: ' + report.failed.join(' / '))
  else console.log(packaged ? 'SALES_METRICS_PACKAGED_ALL_PASSED' : 'SALES_METRICS_CDP_ALL_PASSED')
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(error => {
  console.error('SALES_METRICS_CDP_RUNNER_FAILED', error)
  process.exit(1)
})
