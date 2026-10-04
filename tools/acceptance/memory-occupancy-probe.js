/**
 * 内存占用实测探针（只读测量，不改产品代码）。
 *
 * 目的：把「占内存」从感觉变成数字——空载基线是多少、每多开一个店铺页面涨多少、
 * 关掉之后能不能回落。数据全部来自应用自带的只读 IPC `browser:memoryDiagnostics`
 * （主进程 `process.memoryUsage()` + `app.getAppMetrics()`，与任务管理器口径一致），
 * 不读 Cookie、不读页面正文、不写业务数据。
 *
 * 运行：
 *   node tools/acceptance/memory-occupancy-probe.js
 *   set SHOPILOT_MEM_STORES=8 && node tools/acceptance/memory-occupancy-probe.js
 *   set SHOPILOT_MEM_APP_EXE=D:\code\电商浏览器\release\win-unpacked\ShopPilot.exe
 *
 * 隔离性：独立 `--user-data-dir`（artifacts/memory-probe/profile-<时间戳>，跑完删除）、
 * 独立 CDP 端口，**不碰用户自己的实例与真实数据**（与 tools/acceptance 其它脚本同一套路）。
 *
 * 输出：控制台表格 + artifacts/memory-probe/memory-occupancy-<时间戳>.json
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.env.SHOPILOT_MEM_CDP_PORT || 9411)
const STORE_COUNT = Math.max(1, Math.min(20, Number(process.env.SHOPILOT_MEM_STORES || 6)))
// 默认落在系统临时目录：隔离 profile 是纯测量垃圾，不该写进仓库；
// 需要留档时用 SHOPILOT_MEM_OUT_DIR 指到别处。
const PROFILE_ROOT = process.env.SHOPILOT_MEM_OUT_DIR || path.join(os.tmpdir(), 'shopilot-mem-probe')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const userData = path.join(PROFILE_ROOT, 'profile-' + STAMP)
const resultFile = path.join(PROFILE_ROOT, 'memory-occupancy-' + STAMP + '.json')

const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_EXE = process.env.SHOPILOT_MEM_APP_EXE || ''
const packaged = !!APP_EXE

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const MB = kb => Math.round(kb / 1024)

/* ---------------- CDP（与 tools/acceptance 其它脚本同款最小实现） ---------------- */

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null)
  if (!response || !response.ok) return []
  return await response.json()
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

async function findRenderer(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await listTargets()
    const page = targets.find(item => item.type === 'page' && /index\.html/.test(item.url || ''))
    if (page && page.webSocketDebuggerUrl) return page
    if (Date.now() >= deadline) return null
    await sleep(400)
  }
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', event => reject(new Error('WS_ERROR ' + String(event && event.message))))
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
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description
        throw new Error('EVAL_EXCEPTION ' + String(detail || result.exceptionDetails.text))
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
      console.log(`端口 ${port} 被 PID ${pid} 占用，先结束它（否则新实例绑不上端口，测量会连到旧实例）`)
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  } catch { /* 端口空闲 */ }
}

function launch() {
  const args = packaged
    ? ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
    : [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
  // ⚠ 必须剥掉 ELECTRON_RUN_AS_NODE：宿主环境若带着它，Electron 会退化成纯 Node 进程
  // （表现为 "bad option: --user-data-dir" 或 require('electron').app undefined），窗口根本起不来。
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(packaged ? APP_EXE : electronExe, args, {
    cwd: packaged ? path.dirname(APP_EXE) : ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    env
  })
  child.on('error', error => console.error('启动失败：', error.message))
  return child
}

function killTree(child) {
  if (!child || child.killed) return
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
}

/* ---------------- 测量 ---------------- */

async function readDiagnostics(client) {
  const result = await client.evaluate(`
    const r = await window.shopilot.browser.memoryDiagnostics()
    return r && r.ok ? r.data : { error: r && r.error }
  `)
  if (!result || result.error) throw new Error('memoryDiagnostics 失败：' + JSON.stringify(result && result.error))
  return result
}

function summarize(label, diag) {
  const byType = {}
  let totalKb = 0
  let rendererCount = 0
  for (const metric of diag.appMetrics || []) {
    const kb = Number(metric.memory) || 0
    totalKb += kb
    byType[metric.type] = (byType[metric.type] || 0) + kb
    if (metric.type === 'Renderer') rendererCount++
  }
  return {
    label,
    capturedAt: diag.capturedAt,
    totalMB: MB(totalKb),
    byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, MB(v)])),
    rendererCount,
    mainHeapUsedMB: MB(diag.main && diag.main.heapUsed || 0),
    mainRssMB: MB(diag.main && diag.main.rss || 0),
    processCount: (diag.appMetrics || []).length,
    openStores: diag.totals && diag.totals.openStores,
    tabs: diag.totals && diag.totals.tabs,
    attachedGuests: diag.totals && diag.totals.attachedGuests,
    webContents: diag.totals && diag.totals.webContents,
    pageLeases: (diag.pageLeases || []).length,
    stores: diag.stores
  }
}

function printTable(rows) {
  console.log('')
  console.log('阶段                        总内存   Renderer  GPU   Utility  Main   进程  店铺  标签  guest  webContents')
  console.log('-'.repeat(118))
  for (const row of rows) {
    const t = row.byTypeMB
    console.log(
      row.label.padEnd(26) +
      String(row.totalMB + 'MB').padStart(8) +
      String((t.Renderer || 0) + 'MB').padStart(10) +
      String((t.GPU || 0) + 'MB').padStart(6) +
      String((t.Utility || 0) + 'MB').padStart(9) +
      String((t.Browser || 0) + 'MB').padStart(7) +
      String(row.processCount).padStart(6) +
      String(row.openStores).padStart(6) +
      String(row.tabs).padStart(6) +
      String(row.attachedGuests).padStart(7) +
      String(row.webContents).padStart(13)
    )
  }
  console.log('')
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(PROFILE_ROOT)) fs.mkdirSync(PROFILE_ROOT, { recursive: true })
  // 安全闸：任何删除动作前先确认目标确实在 artifacts/memory-probe 下
  const resolvedProfile = path.resolve(userData)
  if (!resolvedProfile.startsWith(path.resolve(PROFILE_ROOT) + path.sep)) {
    throw new Error('拒绝：profile 路径不在 artifacts/memory-probe 下 → ' + resolvedProfile)
  }

  freeDebugPort(PORT)
  console.log(`启动：${packaged ? APP_EXE : electronExe}（隔离 profile ${resolvedProfile}）`)
  const child = launch()
  const rows = []
  let client = null

  try {
    if (!await waitForCdp()) throw new Error('等待 CDP 端口超时')
    const target = await findRenderer()
    if (!target) throw new Error('未找到主窗口渲染目标')
    client = connect(target.webSocketDebuggerUrl)
    await client.ready
    await sleep(2500)

    rows.push(summarize('① 空载基线', await readDiagnostics(client)))

    const storeIds = []
    for (let index = 0; index < STORE_COUNT; index++) {
      const created = await client.evaluate(`
        const r = await window.shopilot.store.create({ name: '内存探针店${index + 1}', platform: 'douyin' })
        return r && r.ok ? r.data.id : { error: r && r.error }
      `)
      if (created && created.error) throw new Error('建店失败：' + JSON.stringify(created.error))
      storeIds.push(created)
      const opened = await client.evaluate(`
        const r = await window.shopilot.browser.open(${JSON.stringify(created)})
        return r && r.ok ? true : { error: r && r.error }
      `)
      if (opened && opened.error) throw new Error('开店失败：' + JSON.stringify(opened.error))
      // 等 guest 挂上（渲染层 webview → did-attach → 主进程 registerWebview），最多 20s
      const deadline = Date.now() + 20000
      for (;;) {
        const diag = await readDiagnostics(client)
        if ((diag.totals?.attachedGuests || 0) >= index + 1 || Date.now() >= deadline) break
        await sleep(700)
      }
      await sleep(1200)
      rows.push(summarize(`② 开第 ${index + 1} 个店铺页`, await readDiagnostics(client)))
    }

    for (const storeId of storeIds) {
      await client.evaluate(`
        const r = await window.shopilot.browser.close(${JSON.stringify(storeId)})
        return r && r.ok ? true : { error: r && r.error }
      `)
    }
    await sleep(3000)
    rows.push(summarize('③ 全部关闭后', await readDiagnostics(client)))
  } finally {
    if (client) client.close()
    killTree(child)
    await sleep(1500)
    try {
      if (fs.existsSync(resolvedProfile)) fs.rmSync(resolvedProfile, { recursive: true, force: true })
    } catch (error) {
      console.log('清理隔离 profile 失败（可手工删除）：', String(error && error.message))
    }
  }

  printTable(rows)
  const baseline = rows[0]
  const first = rows[1]
  const last = rows[rows.length - 2]
  const afterClose = rows[rows.length - 1]
  const perStore = first && baseline ? first.totalMB - baseline.totalMB : 0
  const growth = last && first ? last.totalMB - first.totalMB : 0
  console.log(`每多开 1 个店铺页：+${perStore}MB（第 1 个）`)
  console.log(`从第 1 个到第 ${STORE_COUNT} 个：+${growth}MB（平均 +${STORE_COUNT > 1 ? Math.round(growth / (STORE_COUNT - 1)) : 0}MB/店）`)
  console.log(`全部关闭后相对峰值：${afterClose.totalMB - last.totalMB}MB，相对空载基线：+${afterClose.totalMB - baseline.totalMB}MB`)
  console.log(`渲染进程数：空载 ${baseline.rendererCount} 个 → 峰值 ${last.rendererCount} 个 → 关闭后 ${afterClose.rendererCount} 个`)

  const report = { generatedAt: new Date().toISOString(), packaged, storeCount: STORE_COUNT, rows, derived: { perStoreMB: perStore, growthMB: growth, afterCloseVsBaselineMB: afterClose.totalMB - baseline.totalMB } }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2))
  console.log('\n明细已写入：' + resultFile)
}

main().then(() => process.exit(0)).catch(error => {
  console.error('PROBE_FAILED:', String(error && error.stack || error))
  process.exit(1)
})
