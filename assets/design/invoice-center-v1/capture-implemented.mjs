/**
 * 给「发票中心」的真实实现拍设计验收图（在真实 Electron 应用里，不是 HTML 原型）。
 *
 * 做法与 tools/acceptance/invoice-license-local-verify.js 同路：
 *   隔离 userData → 建店/填营业执照 → 直接往隔离库种入待开票快照（等价于"采集任务跑过一轮"）
 *   → 启动应用 → 走界面点进「数据分析 → 发票中心」→ CDP 截图。
 *
 * 用法：node assets/design/invoice-center-v1/capture-implemented.mjs
 * 产物：本目录 09/10/11-implemented-*.png
 *
 * 注意：ELECTRON_RUN_AS_NODE 必须从子进程环境里删掉，否则 Electron 会当普通 Node 跑，
 * 主进程 require('electron').app 为 undefined 直接崩（本机环境里这个变量是设着的）。
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.SHOPILOT_INVOICE_SHOT_CDP_PORT || '9271'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- 与发票页实测表头对齐的种入数据（列名必须和档案 headerMap 一致） ---------- */
const LIC_A = { name: '上海云锦服饰有限公司', no: '91310115MA1H8N2X3B' }
const LIC_B = { name: '杭州云栖贸易有限公司', no: '91330100MA2XXXXX1A' }
const table = rows => JSON.stringify(rows)

const SEEDS = {
  // 微信小店：三个方向（申请平台开票 / 给平台开票 / 给买家开票空表）
  微信小店: {
    'invoice.applyPlatform': table([
      ['账单号', '账单日期', '账单类型', '可开金额'],
      ['B202609010001', '2026-09-01', '技术服务费', '¥14.89'],
      ['B202609010002', '2026-09-01', '技术服务费', '¥9.49'],
      ['B202609080003', '2026-09-08', '技术服务费', '¥7.12']
    ]),
    'invoice.toPlatform': table([
      ['账单号', '账单日期', '账单类型', '可开金额', '处理状态'],
      ['B202608010011', '2026-08-01', '用户补贴', '¥80.00', '待处理'],
      ['B202608010012', '2026-08-01', '用户补贴', '¥40.00', '待处理']
    ]),
    'invoice.toBuyer': table([['账单号', '账单日期', '账单类型', '可开金额']])
  },
  // 拼多多：订单开票（含一条已逾期、一条临期）
  拼多多: {
    'invoice.toBuyer': table([
      ['订单号', '申请时间', '发票类型', '发票金额', '发票抬头', '企业税号', '订单状态', '承诺开票时间'],
      ['240828-123456789012345', '2026-08-28 14:22', '增值税普通发票', '¥128.00', '杭州明远科技有限公司', '91330106MA2XXXXX9K', '待开票', '2026-09-04'],
      ['240905-223456789012346', '2026-09-05 09:10', '增值税专用发票', '¥216.30', '杭州明远科技有限公司', '91330106MA2XXXXX9K', '待开票', '2026-10-20']
    ])
  },
  // 抖店：我给平台开票
  抖店: {
    'invoice.toPlatform': table([
      ['账单名称', '账单类型', '收票方主体', '账单总额'],
      ['2026年09月账单', '佣金', '抖店平台', '¥680.60']
    ])
  },
  // 快手小店：未开票账单（含一条金额「—」→ 未解析）
  快手小店: {
    'invoice.toPlatform': table([
      ['账单编号', '账单月份', '账单类型', '账单金额（元）', '开票主体名称', '阈值生效时间'],
      ['202609001', '2026年09月', '服务费', '¥120.00', '云栖生活馆', '2026-10-17'],
      ['202609002', '2026年09月', '服务费', '¥72.00', '云栖生活馆', '2026-10-17'],
      ['202609003', '2026年09月', '违约金', '—', '云栖生活馆', '2026-11-16']
    ])
  }
}

/* ---------- 最小 CDP 客户端（复用验收脚本的写法，另加截图） ---------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    await this.ready
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  async shot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
async function waitForCDP(timeoutMs = 40000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}
async function until(fn, timeoutMs = 12000, label = '') {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(200)
  }
  console.error('TIMEOUT waiting: ' + label)
  return last
}
function freePort(port) {
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    for (const pid of new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  } catch { /* free */ }
}

function seed(dbPath, seeds) {
  const db = new DatabaseSync(dbPath)
  try {
    const stmt = db.prepare(`INSERT INTO store_snapshots (id, store_id, metric, value_json, source_run_id, captured_at) VALUES (?, ?, ?, ?, NULL, ?)`)
    for (const [storeId, metrics] of seeds) {
      for (const [metric, value] of Object.entries(metrics)) stmt.run(`snap_${storeId}_${metric}`, storeId, metric, value, Date.now())
    }
  } finally { db.close() }
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-invoice-shot-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const dbPath = path.join(userData, 'shopilot.db')
  freePort(PORT)
  for (const f of ['09-implemented-overview.png', '10-implemented-summary.png', '11-implemented-detail.png']) {
    try { fs.unlinkSync(path.join(HERE, f)) } catch { /* ignore */ }
  }

  const env = { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
  delete env.ELECTRON_RUN_AS_NODE // 见文件头说明：不删会把 Electron 当普通 Node 跑
  let app = null
  try {
    app = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
      { cwd: ROOT, stdio: 'ignore', env })
    await waitForCDP()
    await sleep(1200)

    const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`)
    const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
    if (!target) throw new Error('renderer target not found')
    const ui = new CDP(target.webSocketDebuggerUrl)
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)

    // 1. 建 4 家店（三家填执照、一家留空 → 验「未填写营业执照」分账那一档）
    const plan = [
      ['云锦服饰旗舰店', '微信小店', LIC_A],
      ['云锦家居旗舰店', '拼多多', LIC_A],
      ['云栖美妆旗舰店', '抖店', LIC_B],
      ['云栖生活馆', '快手小店', null]
    ]
    const ids = {}
    for (const [name, platform, license] of plan) {
      const res = await ui.eval(`return await window.shopilot.store.create(${JSON.stringify({ name, platform })})`)
      if (!res.ok) throw new Error(`create ${name}: ${JSON.stringify(res.error)}`)
      ids[name] = res.data.id
      if (license) {
        await ui.eval(`return await window.shopilot.store.update(${JSON.stringify({ storeId: res.data.id, patch: { licenseName: license.name, licenseNo: license.no } })})`)
      }
    }

    // 2. 种入待开票快照（等价于"采集任务跑过一次"）
    seed(dbPath, plan.map(([name, platform]) => [ids[name], SEEDS[platform]]))

    // 3. 重新加载，让渲染层拉到刚建的店与快照
    await ui.eval('location.reload(); return true')
    await sleep(3000)

    // 4. 走界面进「数据分析 → 发票中心」
    await ui.eval(`const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent||'').includes('数据分析')); if (nav) nav.click(); return true`)
    await until(() => ui.eval(`return !!document.querySelector('.unified-route-tabs')`), 12000, 'route tabs')
    await ui.eval(`const tab = [...document.querySelectorAll('.unified-route-tabs button')].find(i => (i.textContent||'').includes('发票中心')); if (tab) tab.click(); return true`)
    const ok = await until(() => ui.eval(`return document.querySelectorAll('[data-test="invoice-row"]').length >= 4`), 15000, 'invoice rows')
    if (!ok) throw new Error('发票中心没渲染出 4 家店')

    // 放大到设计稿同尺寸截屏（1600×1000 @2x）
    await ui.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false })
    await sleep(700)

    await ui.shot(path.join(HERE, '09-implemented-overview.png'))
    console.log('OK  09-implemented-overview.png')

    // 展开第一个方向的明细
    await ui.eval(`
      const btn = document.querySelector('[data-test^="invoice-detail-toggle-"]')
      if (btn) btn.click()
      return true
    `)
    await sleep(500)
    await ui.eval(`document.querySelector('.unified-page').scrollTop = 300; return true`)
    await sleep(300)
    await ui.shot(path.join(HERE, '11-implemented-detail.png'))
    console.log('OK  11-implemented-detail.png')

    // 切到「按主体汇总」
    await ui.eval(`
      const btn = document.querySelector('[data-test="invoice-view-summary"]')
      if (btn) btn.click()
      document.querySelector('.unified-page').scrollTop = 0
      return true
    `)
    await sleep(600)
    await ui.shot(path.join(HERE, '10-implemented-summary.png'))
    console.log('OK  10-implemented-summary.png')

    ui.close()
  } finally {
    if (app && app.exitCode === null) { try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
    await sleep(500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('DONE -> ' + HERE)
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
