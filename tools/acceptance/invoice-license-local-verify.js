/**
 * 发票中心「按店铺营业执照分账与筛选」的本地端到端验收。
 *
 * 用隔离的临时 userData（不动真实店铺数据），流程与真人操作一致：
 *   建店 → 填营业执照（含只用名称的那家）→ 种入待开票快照 → 打开发票中心 → 点胶囊筛选 / 行内补录 → 刷新页面看是否还在。
 * 快照直接用 better-sqlite3 写进隔离库（等价于"采集任务跑过一次"），
 * 因为渲染层没有写 invoice.* 快照的 IPC（手动指标只允许 biz.*）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
// 用 Node 自带的 node:sqlite：仓库里的 better-sqlite3 是按 Electron 的 ABI 编的，
// 普通 node 加载会报 NODE_MODULE_VERSION 不一致。验收脚本只需要读写隔离库，标准库足够。
const { DatabaseSync } = require('node:sqlite')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_INVOICE_LICENSE_CDP_PORT || '9263'
const results = []

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* process already exited */ }
}

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  } catch { /* port is free */ }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
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

  async eval(expression, awaitPromise = true) {
    await this.ready
    const result = await this.send('Runtime.evaluate', {
      expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
      awaitPromise,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function waitForCDP(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`
    const until = Date.now() + 15000
    while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    return !!window.shopilot
  `)
  return cdp
}

/** 页面里等一个条件成立（返回最后的取值，便于失败时打印） */
async function until(ui, expression, timeoutMs = 8000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await ui.eval(expression)
    if (last) return last
    await sleep(200)
  }
  return last
}

const LIC_A = { name: '上海验达贸易有限公司', no: '91310000MA1FL1234X' }
const LIC_B = { name: '杭州验己科技有限公司', no: '91330100MA2AB5678Y' }

/** 抖店「我给平台开票」方向的真实表头（与 shared/constants/invoice.ts 的 headerMap 对齐） */
function ddRows(list) {
  return JSON.stringify([
    ['账单名称', '账单类型', '收票方主体', '账单总额'],
    ...list.map(([id, amount]) => [id, '佣金', '抖店平台', amount])
  ])
}

function seedSnapshots(dbPath, seeds) {
  const db = new DatabaseSync(dbPath)
  try {
    const stmt = db.prepare(`
      INSERT INTO store_snapshots (id, store_id, metric, value_json, source_run_id, captured_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `)
    for (const s of seeds) {
      for (const [metric, value] of Object.entries(s.metrics)) {
        stmt.run(`snap_${s.id}_${metric}`, s.id, metric, value, Date.now())
      }
    }
  } finally {
    db.close()
  }
}

async function main() {
  console.log('=== 发票中心「营业执照分账 + 筛选」本地端到端验收 ===')
  const userData = path.join(os.tmpdir(), 'shopilot-invoice-license-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const dbPath = path.join(userData, 'shopilot.db')
  freeDebugPort(CDP_PORT)

  let app = null
  let ui = null
  try {
    app = spawn(electronExe, [
      root,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    await sleep(1000)
    ui = await connectUi()

    // ---- 1. 建 5 家店（1 家不填营业执照，1 家只填名称） ----
    const created = {}
    for (const name of ['验达-A1', '验达-A2', '验达-A3', '验己-B1', '未填-N1']) {
      const res = await ui.eval(`return await window.shopilot.store.create(${JSON.stringify({ name, platform: '抖店' })})`)
      check(`创建店铺 ${name}`, res.ok && !!res.data?.id, JSON.stringify(res.error || ''))
      if (res.ok) created[name] = res.data.id
    }
    if (Object.keys(created).length !== 5) throw new Error('failed to create stores')

    // 迁移 v3 必须真的把两列加到库里（老库升级路径）
    const db = new DatabaseSync(dbPath)
    const cols = db.prepare('PRAGMA table_info(stores)').all().map(c => c.name)
    db.close()
    check('stores 表已迁移出 license_name / license_no 两列',
      cols.includes('license_name') && cols.includes('license_no'), cols.join(','))

    // ---- 2. 通过 IPC 填营业执照（A2 故意写小写 + 连字符，验证落库前的归一化） ----
    const patches = [
      ['验达-A1', { licenseName: LIC_A.name, licenseNo: LIC_A.no }],
      ['验达-A2', { licenseName: LIC_A.name, licenseNo: '91310000ma1fl-1234x' }],
      ['验达-A3', { licenseName: LIC_A.name }],                       // 只填名称 → 应并进 A 主体
      ['验己-B1', { licenseName: LIC_B.name, licenseNo: LIC_B.no }]
    ]
    for (const [name, patch] of patches) {
      const res = await ui.eval(`return await window.shopilot.store.update(${JSON.stringify({ storeId: created[name], patch })})`)
      check(`填营业执照 ${name}`, res.ok, JSON.stringify(res.error || ''))
    }

    const listed = await ui.eval(`
      const res = await window.shopilot.store.list()
      return (res.data || []).map(s => ({ name: s.name, licenseName: s.licenseName, licenseNo: s.licenseNo }))
    `)
    const a2 = listed.find(s => s.name === '验达-A2')
    check('统一社会信用代码落库前被归一化（大写、去连字符）', a2?.licenseNo === LIC_A.no, JSON.stringify(a2))
    check('没填营业执照的店铺两个字段都是空', (() => {
      const n1 = listed.find(s => s.name === '未填-N1')
      return n1 && !n1.licenseName && !n1.licenseNo
    })(), JSON.stringify(listed.find(s => s.name === '未填-N1')))

    // ---- 3. 种入待开票快照（等价于采集任务跑过一轮） ----
    // A1 两笔（¥10.00 + ¥2.50）、A2 一笔（¥100.00）、B1 一笔（¥7.00）、N1 一笔（¥1.00）；
    // A3 故意不给数据 → 用来验证"主体下有 3 家店，但只有 2 家有票"不会互相干扰。
    seedSnapshots(dbPath, [
      { id: created['验达-A1'], metrics: { 'invoice.toPlatform': ddRows([['DD-A1-1', '¥10.00'], ['DD-A1-2', '¥2.50']]) } },
      { id: created['验达-A2'], metrics: { 'invoice.toPlatform': ddRows([['DD-A2-1', '¥100.00']]) } },
      { id: created['验己-B1'], metrics: { 'invoice.toPlatform': ddRows([['DD-B1-1', '¥7.00']]) } },
      { id: created['未填-N1'], metrics: { 'invoice.toPlatform': ddRows([['DD-N1-1', '¥1.00']]) } }
    ])

    // 上一步是直接调 IPC 建的店/填的执照，渲染层的店铺列表还是空的 → 刷新一次让它重新拉
    await ui.eval('location.reload(); return true;')
    await sleep(2800)
    await until(ui, `return document.querySelectorAll('[data-test="store-card"]').length === 5`)

    // ---- 4. 打开发票中心（走界面入口，不调内部函数） ----
    await ui.eval(`document.querySelector('[data-test="invoice-center-open"]').click(); return true`)
    const opened = await until(ui, `return !!document.querySelector('[data-test="invoice-center-modal"]')`)
    check('点左栏「发票中心」能打开面板', !!opened)

    await until(ui, `return document.querySelectorAll('[data-test="invoice-row"]').length === 5`)
    const chips = await ui.eval(`
      return [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())
    `)
    check('筛选条列出全部 / 三个主体结构（A 主体 3 家、B 主体 1 家、未填写 1 家、A3 只填名称也归到 A）',
      chips.length === 4 &&
      chips[0].includes('全部') && chips[0].includes('5 家') &&
      chips[1].includes(LIC_A.name) && chips[1].includes('3 家') &&
      chips[2].includes(LIC_B.name) && chips[2].includes('1 家') &&
      chips[3].includes('未填写营业执照') && chips[3].includes('1 家'),
      JSON.stringify(chips))

    const totalsAll = await ui.eval(`
      return [...document.querySelectorAll('[data-test="invoice-totals"] .dc-num')].map(el => el.textContent.trim())
    `)
    check('全部视角：待开票 5 条 / 合计 ¥120.50 / 有待办 4 家',
      totalsAll[0] === '5' && totalsAll[1] === '¥120.50' && totalsAll[2] === '4',
      JSON.stringify(totalsAll))

    // ---- 5. 点 A 主体 → 只留 A 的三家店，合计算的是 A 的票 ----
    await ui.eval(`
      const chips = [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')]
      chips.find(el => el.textContent.includes(${JSON.stringify(LIC_A.name)})).click()
      return true
    `)
    await sleep(300)
    const aView = await ui.eval(`
      return {
        stores: [...document.querySelectorAll('[data-test="invoice-row"] .inv-row-head > b')].map(el => el.textContent.trim()),
        totals: [...document.querySelectorAll('[data-test="invoice-totals"] .dc-num')].map(el => el.textContent.trim()),
        chipOn: [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip.on')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())
      }
    `)
    check('按 A 主体筛选：只剩它的 3 家店（含没票的 A3）',
      JSON.stringify(aView.stores.sort()) === JSON.stringify(['验达-A1', '验达-A2', '验达-A3'].sort()),
      JSON.stringify(aView.stores))
    check('筛选后合计跟着变成 A 主体自己的：3 条 / ¥112.50 / 有待办 2 家',
      aView.totals[0] === '3' && aView.totals[1] === '¥112.50' && aView.totals[2] === '2',
      JSON.stringify(aView.totals))
    check('选中的胶囊有高亮（看得出当前在按谁筛）', aView.chipOn.length === 1, JSON.stringify(aView.chipOn))

    // ---- 6. 点「未填写」→ 只剩那一家；再点一下取消筛选 ----
    await ui.eval(`
      [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')]
        .find(el => el.textContent.includes('未填写')).click()
      return true
    `)
    await sleep(300)
    const noneView = await ui.eval(`
      return [...document.querySelectorAll('[data-test="invoice-row"] .inv-row-head > b')].map(el => el.textContent.trim())
    `)
    check('「未填写营业执照」能单独筛出来补录', JSON.stringify(noneView) === JSON.stringify(['未填-N1']), JSON.stringify(noneView))

    await ui.eval(`
      [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')]
        .find(el => el.textContent.includes('未填写')).click()
      return true
    `)
    await sleep(300)
    const backAll = await ui.eval(`return document.querySelectorAll('[data-test="invoice-row"]').length`)
    check('再点一次取消筛选，回到全部 5 家', backAll === 5, String(backAll))

    // ---- 7. 行内补录：先填一个错位数，必须报错且不落库 ----
    await ui.eval(`document.querySelector('[data-test="invoice-store-license-${created['未填-N1']}"]').click(); return true`)
    await until(ui, `return !!document.querySelector('[data-test="invoice-license-edit-${created['未填-N1']}"]')`)
    const badSave = await ui.eval(`
      const setVal = (sel, v) => {
        const el = document.querySelector(sel)
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal('[data-test="invoice-license-name"]', ${JSON.stringify(LIC_B.name)})
      setVal('[data-test="invoice-license-no"]', '91330100MA2AB56')
      document.querySelector('[data-test="invoice-license-save"]').click()
      const until = Date.now() + 4000
      while (Date.now() < until && !document.querySelector('[data-test="invoice-license-error"]')) await new Promise(r => setTimeout(r, 100))
      return {
        error: document.querySelector('[data-test="invoice-license-error"]')?.textContent.trim() || '',
        stillEditing: !!document.querySelector('[data-test="invoice-license-edit-${created['未填-N1']}"]')
      }
    `)
    check('信用代码位数不对时报出原因、编辑框不关闭（不是静默失败）',
      badSave.error.includes('统一社会信用代码') && badSave.stillEditing, JSON.stringify(badSave))
    const afterBad = await ui.eval(`
      const res = await window.shopilot.store.list()
      const s = (res.data || []).find(x => x.id === ${JSON.stringify(created['未填-N1'])})
      return { licenseName: s?.licenseName || null, licenseNo: s?.licenseNo || null }
    `)
    check('校验失败时没有把错误数据落库', !afterBad.licenseName && !afterBad.licenseNo, JSON.stringify(afterBad))

    // ---- 8. 改成正确值 → 保存成功，主体结构立刻跟着变 ----
    await ui.eval(`
      const setVal = (sel, v) => {
        const el = document.querySelector(sel)
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal('[data-test="invoice-license-no"]', ${JSON.stringify(LIC_B.no)})
      document.querySelector('[data-test="invoice-license-save"]').click()
      return true
    `)
    const saved = await until(ui, `return !document.querySelector('[data-test="invoice-license-edit-${created['未填-N1']}"]')`)
    check('保存成功后编辑框关闭', !!saved)
    const chipsAfter = await ui.eval(`
      return [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())
    `)
    check('补录后「未填写」消失，B 主体变成 2 家',
      chipsAfter.length === 3 && chipsAfter[1].includes(LIC_A.name) && chipsAfter[1].includes('3 家') &&
      chipsAfter[2].includes(LIC_B.name) && chipsAfter[2].includes('2 家') &&
      !chipsAfter.some(c => c.includes('未填写')),
      JSON.stringify(chipsAfter))

    // ---- 9. 主进程汇总也带营业执照（导出 CSV 的两列是它给的） ----
    const payload = await ui.eval(`
      const res = await window.shopilot.overview.invoiceCenter()
      const row = (res.data.rows || []).find(r => r.storeId === ${JSON.stringify(created['验达-A1'])})
      return { licenseName: row?.licenseName || null, licenseNo: row?.licenseNo || null }
    `)
    check('发票中心汇总数据带出营业执照（导出 CSV 的「营业执照 / 统一社会信用代码」两列）',
      payload.licenseName === LIC_A.name && payload.licenseNo === LIC_A.no, JSON.stringify(payload))

    // ---- 10. 刷新页面：营业执照与筛选条都还在（真落库了） ----
    await ui.eval('location.reload(); return true;')
    await sleep(2800)
    await ui.eval(`document.querySelector('[data-test="invoice-center-open"]').click(); return true`)
    await until(ui, `return document.querySelectorAll('[data-test="invoice-row"]').length === 5`)
    const chipsReload = await ui.eval(`
      return [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())
    `)
    check('刷新页面后仍是 3 个主体（A 3 家 / B 2 家 / 无未填写）',
      chipsReload.length === 3 && chipsReload[1].includes('3 家') && chipsReload[2].includes('2 家'),
      JSON.stringify(chipsReload))
  } finally {
    ui?.close()
    killTree(app)
    try {
      const resolvedTemp = path.resolve(os.tmpdir())
      const resolvedUserData = path.resolve(userData)
      if (resolvedUserData.startsWith(resolvedTemp + path.sep)) {
        fs.rmSync(resolvedUserData, { recursive: true, force: true })
      }
    } catch { /* test cleanup only */ }
  }

  const passed = results.filter(item => item.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed !== results.length) process.exit(1)
}

main().catch(err => {
  console.error(err.stack || err)
  process.exit(1)
})
