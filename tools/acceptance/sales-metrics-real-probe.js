/**
 * 经营数据自动采集 · 真实平台探测（开发文档 §11/§15 的真实验收层）。
 *
 * 运行方式（Windows，**必须先关掉用户自己的 ShopPilot 实例**——单实例锁会让新进程直接退出）：
 *   node tools/acceptance/sales-metrics-real-probe.js
 *
 * 与 sales-metrics-cdp-verify.js 的区别（这是本脚本存在的唯一理由）：
 *   · 用**真实的 user data 目录**，因此用的是真实店铺登录态；
 *   · 打开每个真实店铺的浏览器、驱动 Adapter 导航到已登记的经营数据页并读数；
 *   · 输出每个平台的真实结果：状态、原因码、字段值与来源、Adapter 版本、脱敏证据条数。
 *
 * 它**不是**自证成功的脚本：读不到就打印读不到。判定"是否 VERIFIED"必须有人来看这份输出，
 * 并且要求所有平台都拿到真实字段；本脚本自身不会输出任何"通过"字样。
 *
 * 只读语义：唯一动作是把店铺标签页导航到已登录的经营数据页并点一次周期控件；
 * 不点击任何有副作用的按钮、不导出文件、不改店铺配置、不删任何数据。
 * 写入的只有本就属于该功能的台账：采集计划、运行记录、统一指标与脱敏证据。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.env.SHOPILOT_SM_REAL_PORT || 9302)
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const artifactsDir = path.join(ROOT, 'artifacts', 'sales-metrics')
/** 允许只跑部分平台（调试时不必等四个平台跑完）：SHOPILOT_SM_PLATFORMS=微信小店,抖店 */
const PLATFORMS = (process.env.SHOPILOT_SM_PLATFORMS || '微信小店,快手小店,抖店,拼多多').split(',').map(item => item.trim()).filter(Boolean)
const RUN_TIMEOUT_MS = Number(process.env.SHOPILOT_SM_RUN_TIMEOUT_MS || 240000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null)
  if (!response || !response.ok) return []
  return await response.json()
}

async function findRenderer(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await listTargets()).find(item => item.type === 'page' && /index\.html/.test(item.url || ''))
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
    socket.addEventListener('error', () => reject(new Error('WS_ERROR')))
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
      if (result.exceptionDetails) throw new Error('EVAL_EXCEPTION ' + JSON.stringify(result.exceptionDetails.text))
      return result.result ? result.result.value : undefined
    },
    close() { try { socket.close() } catch { /* ignore */ } }
  }
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

function killTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
}

/**
 * 前台保持。
 *
 * 这个仓库里已经踩过：窗口被遮挡时 Chromium 停掉合成与 rAF，靠 rAF 渲染的平台页面
 * 会一直停在"外壳"状态（微信小店的经营数据区在 micro-app 的 ShadowRoot 里，
 * 正是这种页面的典型）。真机探测必须让窗口保持前台，否则会把"没渲染"误判成"页面改版"。
 * 与 tools/acceptance/run-acceptance.ps1 的 keep-foreground 同一思路；设
 * SHOPILOT_NO_KEEP_FOREGROUND=1 可关掉。
 */
let foregroundTimer = null
function startForegroundKeeper(pid) {
  if (process.env.SHOPILOT_NO_KEEP_FOREGROUND === '1') return
  const script = `$w=New-Object -ComObject WScript.Shell; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and $p.MainWindowTitle){ [void]$w.AppActivate($p.MainWindowTitle) }`
  foregroundTimer = setInterval(() => {
    try { execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore', timeout: 4000 }) } catch { /* 窗口还没建好/已被关闭 */ }
  }, 2500)
  if (typeof foregroundTimer.unref === 'function') foregroundTimer.unref()
}
function stopForegroundKeeper() {
  if (foregroundTimer) { clearInterval(foregroundTimer); foregroundTimer = null }
}

async function stopApp(child) {
  if (!child) return
  // **直接按进程树强杀**，不要先 SIGTERM 再 taskkill：
  // 在 Windows 上 SIGTERM 是 TerminateProcess，父进程一死，`taskkill /T` 就再也枚举不到
  // 它的子进程了——实测留下 5 个 electron.exe 孤儿，下一次探测会被自己的"已有实例"守卫拦住。
  // 被强杀留下的 RUNNING 由下次启动的 reconcileOrphanRuns 收敛（另有一条 CDP 用例覆盖）。
  killTree(child.pid)
  const deadline = Date.now() + 8000
  while (child.exitCode == null && Date.now() < deadline) await sleep(300)
  await sleep(600)
}

function money(minor) {
  if (minor == null) return 'null（没有可靠数据）'
  return `¥${(minor / 100).toFixed(2)}`
}
function countOf(value) {
  return value == null ? 'null（没有可靠数据）' : String(value)
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true })
  console.log('真实平台探测：使用真实 user data（不影响商店配置，只写采集台账）')
  console.log('要求：用户自己的 ShopPilot 实例必须已关闭（单实例锁）')

  const other = require('child_process').execSync('tasklist /FI "IMAGENAME eq ShopPilot.exe" /NH', { encoding: 'utf8' })
  const electronList = require('child_process').execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: 'utf8' })
  if (/ShopPilot\.exe/i.test(other) || /electron\.exe/i.test(electronList)) {
    console.log('检测到已有实例在运行；为避免连接/结束其它进程，停止本次探测。')
    console.log(other.trim())
    console.log(electronList.trim())
    process.exit(2)
  }

  // 不传 --user-data-dir：走应用自身的默认目录，保证与用户日常启动是同一份数据。
  const child = spawn(electronExe, [
    ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => { /* 收敛噪声 */ })
  child.stderr.on('data', () => { /* 同上 */ })

  const report = { startedAt: new Date().toISOString(), platforms: {}, stores: [] }
  let cdp = null
  try {
    if (!await waitForCdp()) throw new Error('应用未在 40 秒内暴露 CDP')
    startForegroundKeeper(child.pid)
    console.log('已开启前台保持（窗口被遮挡会让 micro-app 类页面停止渲染）')
    const target = await findRenderer()
    if (!target) throw new Error('找不到渲染层目标')
    cdp = connect(target.webSocketDebuggerUrl)
    await cdp.ready
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await cdp.evaluate('return Boolean(window.shopilot && window.shopilot.salesMetrics);').catch(() => false)) break
      await sleep(500)
    }

    const storeList = await cdp.evaluate('return await window.shopilot.store.list();')
    if (!storeList.ok) throw new Error('store:list 失败 ' + JSON.stringify(storeList.error))
    const stores = storeList.data.filter(store => PLATFORMS.includes(store.platform))
    report.stores = stores.map(store => ({ id: store.id, name: store.name, platform: store.platform, status: store.status }))
    console.log(`真实店铺：${report.stores.map(store => `${store.platform}/${store.name}`).join('，')}`)

    const plans = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    console.log(`采集计划：${plans.ok ? plans.data.items.length : '读取失败'} 条`)

    // 每个平台挑一个店铺做真实采集（一家家来，避免把真实浏览器的标签页同时刷满）
    const picked = []
    for (const platform of PLATFORMS) {
      const store = stores.find(item => item.platform === platform && !picked.some(entry => entry.id === item.id))
      if (store) picked.push(store)
    }

    for (const store of picked) {
      console.log(`\n=== ${store.platform} / ${store.name} ===`)
      const entry = { storeId: store.id, storeName: store.name, platform: store.platform }
      try {
        const opened = await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(store.id)});`)
        entry.opened = opened.ok === true
        await sleep(3000)
        const tabs = await cdp.evaluate(`return await window.shopilot.browser.tab.list(${JSON.stringify(store.id)});`)
        entry.urlBefore = tabs.ok && tabs.data.tabs.length ? String(tabs.data.tabs[0].url || '').slice(0, 160) : null

        // 先记住"当前最新的一条运行"：立即采集只入队，runId 由节拍创建，
        // 因此必须按 runId 变化来识别**这一次**的运行——否则会把上一次的终态记录
        // 当成本次结果读走（实测踩到：四个平台秒回上一次的失败原因）。
        const before = await cdp.evaluate(`return await window.shopilot.salesMetrics.runs({ storeId: ${JSON.stringify(store.id)}, pageSize: 3 });`)
        const beforeRunId = before.ok && before.data.items.length ? before.data.items[0].runId : null

        const runNow = await cdp.evaluate(`return await window.shopilot.salesMetrics.planRunNow(${JSON.stringify(store.id)});`)
        entry.runNow = runNow.ok ? 'QUEUED' : JSON.stringify(runNow.error)
        console.log(`  立即采集：${entry.runNow}`)

        const deadline = Date.now() + RUN_TIMEOUT_MS
        let last = null
        let sawRunning = false
        while (Date.now() < deadline) {
          const runs = await cdp.evaluate(`return await window.shopilot.salesMetrics.runs({ storeId: ${JSON.stringify(store.id)}, pageSize: 3 });`)
          const newest = runs.ok && runs.data.items.length ? runs.data.items[0] : null
          if (newest && newest.runId !== beforeRunId) {
            last = newest
            if (last.status === 'RUNNING') {
              if (!sawRunning) { sawRunning = true; console.log('  … RUNNING') }
            } else break
          }
          await sleep(2000)
        }
        entry.beforeRunId = beforeRunId
        entry.sawRunning = sawRunning
        entry.run = last ? {
          runId: last.runId, status: last.status, reasonCode: last.reasonCode, safeMessage: last.safeMessage,
          durationMs: last.durationMs, adapterVersion: last.adapterVersion, sourceType: last.sourceType,
          inserted: last.inserted, updated: last.updated
        } : null
        console.log(`  运行结果：${last ? `${last.status} / ${last.reasonCode} / ${last.safeMessage}` : '未产生新的运行记录'}`)

        const plan = await cdp.evaluate(`return await window.shopilot.salesMetrics.planGet(${JSON.stringify(store.id)});`)
        if (plan.ok) {
          const view = plan.data
          entry.plan = {
            status: view.lastStatus, freshness: view.freshness, dataStatus: view.dataStatus,
            sourceType: view.sourceType, adapterVersion: view.adapterVersion,
            collectedAt: view.collectedAt, lastSuccessAt: view.lastSuccessAt,
            consecutiveFailures: view.consecutiveFailures, nextRunAt: view.nextRunAt
          }
          entry.metrics = view.metrics ? {
            periodType: view.metrics.periodType, periodStart: view.metrics.periodStart, periodEnd: view.metrics.periodEnd,
            orderCount: view.metrics.orderCount, paidOrderCount: view.metrics.paidOrderCount,
            salesQuantity: view.metrics.salesQuantity,
            grossSalesAmountMinor: view.metrics.grossSalesAmountMinor,
            paidSalesAmountMinor: view.metrics.paidSalesAmountMinor,
            refundAmountMinor: view.metrics.refundAmountMinor,
            refundOrderCount: view.metrics.refundOrderCount,
            refundQuantity: view.metrics.refundQuantity,
            netSalesAmountMinor: view.metrics.netSalesAmountMinor,
            dataStatus: view.metrics.dataStatus
          } : null
          console.log(`  口径：${view.metrics ? `${view.metrics.periodType}（${new Date(view.metrics.periodStart).toLocaleString('zh-CN')} → ${new Date(view.metrics.periodEnd).toLocaleString('zh-CN')}）` : '无指标行'}`)
          if (entry.metrics) {
            console.log(`  成交金额：${money(entry.metrics.paidSalesAmountMinor ?? entry.metrics.grossSalesAmountMinor)}｜成交订单：${countOf(entry.metrics.paidOrderCount)}｜退款金额：${money(entry.metrics.refundAmountMinor)}｜退款订单：${countOf(entry.metrics.refundOrderCount)}｜销量：${countOf(entry.metrics.salesQuantity)}`)
          }
          console.log(`  来源：${view.sourceType}｜Adapter：${view.adapterVersion || '未执行到 Adapter'}｜新鲜度：${view.freshness}｜数据状态：${view.dataStatus}`)
        }
      } catch (error) {
        entry.error = String(error && error.message || error)
        console.log(`  探测异常：${entry.error}`)
      }
      report.platforms[store.platform] = entry
    }

    // 脱敏证据：成功读到字段的平台应当有证据行
    const health = await cdp.evaluate('return await window.shopilot.salesMetrics.health();')
    report.health = health.ok ? health.data.counters : null
    console.log(`\n健康汇总：${JSON.stringify(report.health)}`)
  } catch (error) {
    report.error = String(error && error.message || error)
    console.log('探测失败：' + report.error)
  } finally {
    stopForegroundKeeper()
    try { if (cdp) cdp.close() } catch { /* ignore */ }
    await stopApp(child)
  }

  fs.writeFileSync(path.join(artifactsDir, 'real-probe.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果已写入 artifacts/sales-metrics/real-probe.json`)
  console.log('判定口径：只有四个平台都拿到真实字段（sourceType 非 NONE、metrics 非空）才算"真实字段来源通过"。')
  process.exit(0)
}

main().catch(error => { console.error('REAL_PROBE_FAILED', error); process.exit(1) })
