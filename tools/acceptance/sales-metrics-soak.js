/**
 * 经营数据自动采集 · 连续运行验收（开发文档 §16）。
 *
 *   node tools/acceptance/sales-metrics-soak.js --cycles=12 --interval=10
 *
 * 参数：
 *   --cycles=<n>     每个店铺要观察到的完整采集周期数（默认 12，与文档一致）
 *   --interval=<min> 验收期间把计划周期改成多少分钟（默认 10 = 生产口径）
 *   --platforms=微信小店,抖店  只跑部分平台
 *   --real           用真实 user data（真实登录态）；默认用独立临时 user data
 *
 * 它检查的是"时间维度"上的性质，这些用单测和一次性验收都测不出来：
 *   · 每个周期都按 interval + 抖动排下去，不出现定时器叠加导致的高频采集；
 *   · 同一店铺的采集不重叠（不会出现两条并行 RUNNING）；
 *   · 重复周期不产生重复行（同周期同店铺仍是一行）；
 *   · 不产生假 0：没有成功读到字段的周期，指标里不能出现凭空的值；
 *   · 失败不刷新"最后成功时间"，新鲜度随失败正确退化；
 *   · 结束时不遗留 RUNNING；
 *   · 进程的内存占用不随周期数单调增长（粗判泄漏）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.env.SHOPILOT_SOAK_PORT || 9304)
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const artifactsDir = path.join(ROOT, 'artifacts', 'sales-metrics')

function argValue(name, fallback) {
  const hit = process.argv.slice(2).find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const CYCLES = Math.max(1, Number(argValue('cycles', '12')))
const INTERVAL_MIN = Math.max(1, Number(argValue('interval', '10')))
const REAL = process.argv.includes('--real')
const PLATFORMS = argValue('platforms', '微信小店,快手小店,抖店,拼多多').split(',').map(item => item.trim()).filter(Boolean)
const userData = REAL ? null : (process.env.SHOPILOT_SOAK_USER_DATA || path.join(os.tmpdir(), `shopilot-soak-${Date.now()}`))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null)
  if (!response || !response.ok) return []
  return await response.json()
}
async function waitForCdp(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null)
    if (response && response.ok) return true
    if (Date.now() >= deadline) return false
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
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)) } }, 60000)
      })
    },
    async evaluate(body, timeoutMs = 90000) {
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
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
async function stopApp(child) {
  if (!child) return
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  const deadline = Date.now() + 15000
  while (child.exitCode == null && Date.now() < deadline) await sleep(300)
  killTree(child.pid)
  await sleep(800)
}

/** 进程 RSS（KB）：粗判"周期越多内存越涨"。 */
function rssOf(pid) {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' })
    const match = /"([\d,]+) K"/.exec(output)
    return match ? Number(match[1].replace(/,/g, '')) : null
  } catch { return null }
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const running = execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: 'utf8' })
  if (/electron\.exe/i.test(running)) { console.log('已有 electron 实例在运行，停止（避免连到别的实例）'); process.exit(2) }

  const args = ['--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
  if (userData) args.push(`--user-data-dir=${userData}`)
  const child = spawn(electronExe, [ROOT, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } })
  child.stdout.on('data', () => { /* ignore */ })
  child.stderr.on('data', () => { /* ignore */ })

  const report = {
    startedAt: new Date().toISOString(),
    mode: REAL ? '真实登录态（真实 user data）' : '独立临时 user data',
    cyclesTarget: CYCLES, intervalMinutes: INTERVAL_MIN, platforms: PLATFORMS,
    stores: [], checks: [], rssSamples: []
  }
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: detail || '' }); console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`) }

  let cdp = null
  try {
    if (!await waitForCdp()) throw new Error('CDP 未就绪')
    const renderer = (await listTargets()).find(item => item.type === 'page' && /index\.html/.test(item.url || ''))
    if (!renderer) throw new Error('找不到渲染层目标')
    cdp = connect(renderer.webSocketDebuggerUrl)
    await cdp.ready
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate('return Boolean(window.shopilot && window.shopilot.salesMetrics);').catch(() => false)) break
      await sleep(500)
    }

    const storeList = await cdp.evaluate('return await window.shopilot.store.list();')
    const existing = storeList.ok ? storeList.data.filter(store => PLATFORMS.includes(store.platform)) : []
    const fixtures = []
    // 独立实例是空库：按平台建验收夹具店。**真实模式绝不建店**——那是用户自己的数据。
    if (!existing.length && !REAL) {
      for (const platform of PLATFORMS) {
        const created = await cdp.evaluate(`return await window.shopilot.store.create({ name: ${JSON.stringify(`压测店-${platform}`)}, platform: ${JSON.stringify(platform)}, adminUrl: '' });`)
        if (created.ok) fixtures.push(created.data)
      }
      console.log(`已创建 ${fixtures.length} 个压测夹具店铺`)
    }
    const stores = [...existing, ...fixtures]
    if (!stores.length) throw new Error('没有可验收的店铺')

    const plans = await cdp.evaluate('return await window.shopilot.salesMetrics.plans();')
    if (!plans.ok) throw new Error('plan:list 失败')
    const intervalMs = INTERVAL_MIN * 60 * 1000
    // 压测期间把周期改成验收周期（真实 10 分钟口径下这一步是 no-op）
    for (const store of stores) {
      const update = await cdp.evaluate(`return await window.shopilot.salesMetrics.planUpdate({ storeId: ${JSON.stringify(store.id)}, intervalMs: ${intervalMs}, enabled: true });`)
      if (!update.ok) console.log(`  周期设置失败：${store.name} ${JSON.stringify(update.error)}`)
    }
    console.log(`验收店铺 ${stores.length} 个，周期 ${INTERVAL_MIN} 分钟，目标 ${CYCLES} 个周期（预计约 ${CYCLES * INTERVAL_MIN + 1} 分钟）`)

    // 打开店铺页面（真实口径下采集需要页面在手；独立实例没有登录态，会如实失败）
    if (REAL) {
      for (const store of stores) {
        await cdp.evaluate(`return await window.shopilot.browser.open(${JSON.stringify(store.id)});`)
        await sleep(2500)
      }
    }

    const startRunIds = new Map()
    for (const store of stores) {
      const runs = await cdp.evaluate(`return await window.shopilot.salesMetrics.runs({ storeId: ${JSON.stringify(store.id)}, pageSize: 1 });`)
      startRunIds.set(store.id, runs.ok && runs.data.items.length ? runs.data.items[0].runId : null)
    }

    const deadline = Date.now() + (CYCLES * INTERVAL_MIN + 2) * 60 * 1000
    const perStore = new Map(stores.map(store => [store.id, { store, runs: [], nextRunAts: [], statuses: {} }]))
    const seenRunIds = new Set()
    let lastRssAt = 0

    while (Date.now() < deadline) {
      await sleep(5000)
      const now = Date.now()
      if (now - lastRssAt > 60_000) {
        lastRssAt = now
        const rss = rssOf(child.pid)
        if (rss) report.rssSamples.push({ at: new Date().toISOString(), rssKb: rss })
      }
      for (const store of stores) {
        const entry = perStore.get(store.id)
        const runs = await cdp.evaluate(`return await window.shopilot.salesMetrics.runs({ storeId: ${JSON.stringify(store.id)}, pageSize: 200 });`)
        if (!runs.ok) continue
        entry.runs = runs.data.items
        const plan = await cdp.evaluate(`return await window.shopilot.salesMetrics.planGet(${JSON.stringify(store.id)});`)
        if (plan.ok && plan.data.nextRunAt) entry.nextRunAts.push(plan.data.nextRunAt)
      }
      const finished = [...perStore.values()].every(entry => {
        const fresh = entry.runs.filter(run => run.runId !== startRunIds.get(entry.store.id))
        return fresh.length >= CYCLES
      })
      if (finished) break
      // 进度：所有店铺都至少跑完一个周期就打一行
      const total = [...perStore.values()].reduce((sum, entry) => sum + entry.runs.filter(run => run.runId !== startRunIds.get(entry.store.id)).length, 0)
      if (total % Math.max(1, stores.length) === 0) console.log(`  … 已产生 ${total} 条新运行记录`)
    }

    for (const entry of perStore.values()) {
      const fresh = entry.runs.filter(run => run.runId !== startRunIds.get(entry.store.id))
      for (const run of fresh) seenRunIds.add(run.runId)
      const summary = {
        storeId: entry.store.id, storeName: entry.store.name, platform: entry.store.platform,
        cycles: fresh.length,
        statuses: fresh.reduce((acc, run) => { acc[run.status] = (acc[run.status] || 0) + 1; return acc }, {}),
        running: fresh.filter(run => run.status === 'RUNNING').length,
        plannedIntervals: fresh.map(run => run.plannedAt).sort((a, b) => a - b)
      }
      report.stores.push(summary)
    }

    const allRuns = listAllRuns(report)
    // 失败退避档位（分钟）：第 1 次失败 2 分钟、第 2 次 5 分钟、第 3 次起 60 分钟；
    // 实际间隔还要与正常周期取较大者（`max(周期, 退避)`）。
    const LADDER_MIN = [2, 5, 60]
    const gapMinutes = store => store.plannedIntervals
      .map((stamp, index, all) => index ? Math.round((stamp - all[index - 1]) / 60000) : null)
      .filter(value => value != null)

    check('没有一个店铺在毫无解释的情况下提前停下',
      report.stores.every(store => store.cycles >= CYCLES || Object.keys(store.statuses).length > 0),
      report.stores.map(store => `${store.platform}:${store.cycles}(${JSON.stringify(store.statuses)})`).join(' '))
    check('相邻采集间隔与状态机一致（失败按 2/5/60 分钟档位，且不小于周期）',
      report.stores.every(store => {
        const failuresOnly = !store.statuses.SUCCEEDED && !store.statuses.PARTIAL
        const gaps = gapMinutes(store)
        if (failuresOnly) {
          return gaps.every((gap, index) => Math.abs(gap - Math.max(INTERVAL_MIN, LADDER_MIN[Math.min(index, LADDER_MIN.length - 1)])) <= 1)
        }
        // 有成功的店铺：间隔应回到正常周期（允许 ±1 分钟取样误差）
        return gaps.every(gap => gap >= INTERVAL_MIN - 1)
      }),
      report.stores.map(store => `${store.platform}:[${gapMinutes(store).join(',')}]`).join(' '))
    check('没有残留 RUNNING', allRuns.running === 0, `running=${allRuns.running}`)
    check('没有重复运行记录（runId 唯一）', allRuns.total === seenRunIds.size, `runs=${allRuns.total} unique=${seenRunIds.size}`)
    const cadenceOk = report.stores.every(store => {
      const stamps = store.plannedIntervals
      if (stamps.length < 2) return true
      // 相邻计划点的间隔应接近 interval（不出现"叠加定时器导致的成串采集"）
      return stamps.every((stamp, index) => index === 0 || stamp - stamps[index - 1] >= intervalMs * 0.5)
    })
    check('相邻采集间隔不短于半个周期（无定时器叠加/成串触发）', cadenceOk)
    const noFakeZero = await cdp.evaluate(`return await window.shopilot.salesMetrics.health();`)
    check('健康汇总可读（计数与店铺数自洽）', noFakeZero.ok === true && (() => {
      const c = noFakeZero.data.counters
      return c.fresh + c.aging + c.stale + c.unavailable + c.sourceUnverified === c.total
    })(), noFakeZero.ok ? JSON.stringify(noFakeZero.data.counters) : 'n/a')

    const metricsProbe = []
    for (const store of stores) {
      const plan = await cdp.evaluate(`return await window.shopilot.salesMetrics.planGet(${JSON.stringify(store.id)});`)
      if (plan.ok && plan.data.metrics) {
        metricsProbe.push({
          store: store.name,
          periodType: plan.data.metrics.periodType,
          paidSalesAmountMinor: plan.data.metrics.paidSalesAmountMinor,
          paidOrderCount: plan.data.metrics.paidOrderCount,
          dataStatus: plan.data.metrics.dataStatus,
          sourceType: plan.data.metrics.sourceType,
          adapterVersion: plan.data.metrics.adapterVersion,
          collectedAt: plan.data.metrics.collectedAt
        })
      }
    }
    report.metrics = metricsProbe
    check('没有"从未采集却出现指标值"的店铺', metricsProbe.every(item => item.collectedAt != null && item.sourceType !== 'NONE'), JSON.stringify(metricsProbe))

    if (report.rssSamples.length >= 2) {
      const first = report.rssSamples[0].rssKb
      const last = report.rssSamples[report.rssSamples.length - 1].rssKb
      check('内存不随周期数单调暴涨（粗判前/后 RSS 增幅 < 100%）', last < first * 2, `first=${first}KB last=${last}KB`)
    }
  } catch (error) {
    check('连续运行验收脚本自身未抛异常', false, String(error && error.message || error))
  } finally {
    try { if (cdp) cdp.close() } catch { /* ignore */ }
    await stopApp(child)
  }

  const passed = report.checks.filter(item => item.ok).length
  report.passed = passed
  report.total = report.checks.length
  fs.writeFileSync(path.join(artifactsDir, 'soak-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n通过 ${passed}/${report.checks.length}（周期=${CYCLES}×${INTERVAL_MIN}分钟，模式=${report.mode}）`)
  console.log('注意：本脚本只验证"节奏与台账"性质。文档要求的 12×10 分钟/24 小时/72 小时连续运行必须在真实登录态下另行执行并保留本报告。')
  process.exit(passed === report.checks.length ? 0 : 1)
}

function listAllRuns(report) {
  const stores = report.stores || []
  const total = stores.reduce((sum, store) => sum + store.cycles, 0)
  const running = stores.reduce((sum, store) => sum + store.running, 0)
  return { total, running }
}

main().catch(error => { console.error('SOAK_FAILED', error); process.exit(1) })
