/**
 * 「涉税信息报送」**真机**验收：在正在运行的应用里点一次采集，看真实平台页的数据能不能落到界面上。
 *
 * 与 tools/acceptance/invoice-license-local-verify.js 的区别：那个用隔离库 + 造数据，
 * 这个**必须有一个登录态的快手小店**（平台页面要有真实数据），因此归为 real-verify。
 * 只做两件事：点界面上的「采集涉税报送数据」按钮、等结果渲染；不点任何导出/提交类动作。
 *
 * 前置：应用以 `--remote-debugging-port=<PORT>` 启动（默认 9250），且有至少一家快手小店。
 * 用法：node tools/acceptance/tax-report-real-verify.mjs [CDP端口]
 */
const PORT = process.argv[2] || process.env.SHOPILOT_TAX_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(String(msg.params?.exceptionDetails?.exception?.description || '').slice(0, 200))
      }
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function until(fn, timeoutMs, label) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(1000)
  }
  console.log(`TIMEOUT(${label})`)
  return last
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('没找到应用窗口（应用没起来 / 端口不对）')
  const ui = new CDP(target.webSocketDebuggerUrl)
  await ui.send('Runtime.enable')
  await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)
  if (await ui.eval(`return !!document.querySelector('.lock-overlay')`)) throw new Error('应用处于锁屏状态，先解锁')

  // 走界面进「数据分析 → 发票中心」
  await ui.eval(`const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent||'').includes('数据分析')); if (nav) nav.click(); return true`)
  await until(() => ui.eval(`return !!document.querySelector('.unified-route-tabs')`), 15000, 'route tabs')
  await ui.eval(`const tab = [...document.querySelectorAll('.unified-route-tabs button')].find(i => (i.textContent||'').includes('发票中心')); if (tab) tab.click(); return true`)
  await until(() => ui.eval(`return !!document.querySelector('[data-test="invoice-license-bar"]')`), 20000, 'invoice center')

  /* ---- 1. 涉税分区的静态结构 ---- */
  // 默认视图是「按主体统计」；逐店的那些断言先切到「按店铺」（两个视图各测各的）
  await ui.eval(`const b = document.querySelector('[data-test="tax-view-stores"]'); if (b) b.click(); return true`)
  await sleep(400)
  const staticInfo = await ui.eval(`
    const q = s => document.querySelector(s)
    const rows = [...document.querySelectorAll('[data-test="tax-row"]')].map(el => ({
      store: (el.querySelector('b')?.textContent || '').trim(),
      supported: !el.querySelector('[data-test^="tax-unsupported-"]'),
      periods: el.querySelectorAll('[data-test="tax-period-row"]').length,
      summary: (el.querySelector('[data-test^="tax-summary-"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      // 未实测平台的原因原文（界面上给用户看的就是这句，要能复核）
      unsupportedNote: (el.querySelector('[data-test^="tax-unsupported-"]')?.textContent || '').replace(/\\s+/g, ' ').trim()
    }))
    return {
      section: !!q('[data-test="tax-report"]'),
      collectBtn: !!q('[data-test="tax-collect"]'),
      disclaimer: (q('[data-test="tax-disclaimer"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      rows
    }
  `)
  check('发票中心里有「涉税信息报送」分区', staticInfo.section && staticInfo.collectBtn)
  check('平台用途限制与数据同屏显示，且写明「不得作为税务申报」',
    staticInfo.disclaimer.includes('不得作为税务申报'), staticInfo.disclaimer.slice(0, 80))
  check('逐店列出（含未实测平台的如实说明）', staticInfo.rows.length > 0,
    JSON.stringify(staticInfo.rows.map(r => `${r.store}${r.supported ? '' : '(未实测)'}=${r.periods}期`)))
  // 未实测说明里**不许出现"未找到该入口"这类没查过却下了结论的话**（2026-10-14 自纠）
  for (const r of staticInfo.rows.filter(x => !x.supported)) {
    check(`「${r.store}」未实测说明写的是真查过什么`, !/未找到该入口/.test(r.unsupportedNote), r.unsupportedNote.slice(0, 90))
  }

  const before = staticInfo.rows.reduce((n, r) => n + r.periods, 0)

  /* ---- 2. 点一次真实采集，等数据落屏 ---- */
  console.log(`采前已渲染 ${before} 个报送期；点击「采集涉税报送数据」…`)
  await ui.eval(`const b = document.querySelector('[data-test="tax-collect"]'); if (b) b.click(); return true`)
  const after = await until(() => ui.eval(`
    return [...document.querySelectorAll('[data-test="tax-row"]')].reduce((n, el) => n + el.querySelectorAll('[data-test="tax-period-row"]').length, 0)
  `), 180000, 'tax rows after collection')

  check('真机采集后界面上出现报送期数据（证明实测锚点可用）', after > 0, `${before} → ${after} 期`)

  /* ---- 3. 数据内容：所属期 / 主体 / 税号 / 三段收入 ----
     形状**按平台分开断言**：快手是「2025.12.13-12.31」这种按期的日期区间、且每行带纳税人识别号；
     微信小店只给季度（「2026年第三季度(7-9月)」）且**不给识别号**——拿快手那套去套它必然误报。 */
  const readStoreDetail = async (storeName) => ui.eval(`
    const store = [...document.querySelectorAll('[data-test="tax-row"]')]
      .find(el => (el.querySelector('b')?.textContent || '').includes(${JSON.stringify(storeName)}))
    const row = store ? store.querySelector('[data-test="tax-period-row"]') : null
    if (!row) return null
    const cells = [...row.children].map(td => td.textContent.replace(/\\s+/g, ' ').trim())
    const table = row.closest('table')
    return { head: [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()), cells }
  `)
  // 采集刚结束时页面在重渲染，可能有一瞬读不到 → 重试几次再判定，别把"还没画完"报成"读不到"
  const readStoreDetailRetry = async (storeName) => {
    for (let i = 0; i < 6; i++) {
      const detail = await readStoreDetail(storeName)
      if (detail) return detail
      await sleep(2000)
    }
    return null
  }
  const detail = await readStoreDetailRetry('福气满满')
  if (detail) {
    // 列序：0 所属期 | 1 本期净额合计 | 2 主体名称 | 3 纳税人识别号 | 4~6 货物(金额/退款/净额) | 7~9 服务 | 10 佣金 | 11 订单笔数
    check('表头是实测列，且「本期净额合计」紧跟所属期（最该看的数留在第一屏）',
      detail.head[0] === '涉税数据所属期' && detail.head[1] === '本期净额合计' &&
      detail.head.includes('主体名称') && detail.head.includes('纳税人识别号') &&
      detail.head.includes('货物收入净额') && detail.head.includes('服务收入净额'),
      detail.head.slice(0, 4).join(' | '))
    check('所属期有值（形如 2026.01.01-01.31）', /\d{4}\.\d{2}\.\d{2}/.test(detail.cells[0] || ''), detail.cells[0])
    check('本期净额合计是从三段式文本算出来的金额', /^¥[\d,]+\.\d{2}$|^—$/.test(detail.cells[1] || ''), detail.cells[1])
    check('纳税人识别号有值（18 位或 15 位）', /^[0-9A-Z]{15,18}$/.test(detail.cells[3] || ''), detail.cells[3])
    check('货物收入净额已从三段式文本拆成金额', /^¥[\d,]+\.\d{2}$|^—$/.test(detail.cells[6] || ''), detail.cells[6])
  } else {
    check('能读到一条报送期明细', false)
  }

  const summary = await ui.eval(`
    return [...document.querySelectorAll('[data-test^="tax-summary-"]')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())
  `)
  check('逐店给出「N 个报送期 · 收入净额合计」（合计是算出来的，不是复述单行）',
    summary.some(t => /个报送期/.test(t) && /收入净额合计/.test(t)), JSON.stringify(summary))

  check('渲染过程没有未捕获异常', ui.errors.length === 0, ui.errors[0] || '')

  /* ---- 3b. 微信小店：**读接口响应**那条路（页面渲染不出表格） ---- */
  const weixin = await readStoreDetailRetry('微信小店测试')
  if (weixin) {
    // 接口给的 taxTime 是季度末时间戳 → 界面上是季度文本，不是快手的日期区间
    check('微信小店：读接口响应拿到的所属期是季度（不是日期区间）',
      /^\d{4}年第[一二三四]季度\(\d-\d月\)$/.test(weixin.cells[0] || ''), weixin.cells[0])
    check('微信小店：结算金额/退款金额已从「分」换算成元并显示',
      /^¥[\d,]+\.\d{2}$|^—$/.test(weixin.cells[12] || '') && /^¥[\d,]+\.\d{2}$|^—$/.test(weixin.cells[13] || ''),
      `${weixin.cells[12]} / ${weixin.cells[13]}`)
    // 这一页不给识别号：界面必须显示「—」，**不许**编一个出来
    check('微信小店：没有的列如实显示「—」（这页不给纳税人识别号）',
      (weixin.cells[3] || '') === '—', weixin.cells[3])
  } else {
    check('微信小店：能读到一条报送期明细（读接口响应那条路）', false)
  }

  /* ---- 4. 按主体统计（申报的单位是主体，不是店铺） ---- */
  await ui.eval(`const b = document.querySelector('[data-test="tax-view-subject"]'); if (b) b.click(); return true`)
  await sleep(400)
  const subject = await ui.eval(`
    const q = s => document.querySelector(s)
    const list = q('[data-test="tax-subject-list"]')
    const rows = list
      ? [...list.querySelectorAll('tr[data-test]')]
          .filter(tr => !(tr.getAttribute('data-test') || '').includes('detail'))
          .map(tr => [...tr.children].map(td => td.textContent.replace(/\\s+/g, ' ').trim()))
      : []
    return {
      defaultView: !!q('[data-test="tax-view-subject"]') && q('[data-test="tax-view-subject"]').classList.contains('on'),
      listExists: !!list,
      totals: (q('[data-test="tax-totals"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      rows,
      verdicts: [...document.querySelectorAll('[data-test^="tax-verdict-"]')].map(el => el.textContent.replace(/\\s+/g, ' ').trim()),
      toggles: document.querySelectorAll('[data-test^="tax-subject-toggle-"]').length
    }
  `)
  check('默认「按主体统计」视图', subject.defaultView && subject.listExists)
  check('主体行含 主体名 / 纳税人识别号 / 涉及店铺 / 报送期数 / 净额合计',
    subject.rows.length > 0 &&
    subject.rows.every(r => r.length >= 8 && /^[0-9A-Z]{15,18}$|^—$/.test(r[1]) && /\d/.test(r[3]) && /^¥[\d,]+\.\d{2}$|^—$/.test(r[7])),
    JSON.stringify(subject.rows[0] || []))
  check('合计行给出 主体数 / 涉及店铺 / 报送期数 / 净额合计',
    /个报送主体/.test(subject.totals) && /家店/.test(subject.totals) && /个报送期/.test(subject.totals) && /收入净额合计/.test(subject.totals),
    subject.totals)
  check('每个主体都有核对结论（与执照是否一致）',
    subject.rows.length > 0 && subject.verdicts.length === subject.rows.length && subject.verdicts.every(Boolean),
    JSON.stringify(subject.verdicts))

  // 展开逐期明细：汇总口径要能下钻回原始期间
  await ui.eval(`const b = document.querySelector('[data-test^="tax-subject-toggle-"]'); if (b) b.click(); return true`)
  await sleep(400)
  const periods = await ui.eval(`return document.querySelectorAll('[data-test="tax-subject-period"]').length`)
  check('主体可展开逐期明细（汇总能下钻回原始期间）', periods > 0, `${periods} 期`)
  await ui.eval(`const b = document.querySelector('[data-test^="tax-subject-toggle-"]'); if (b) b.click(); return true`)
  await sleep(300)

  // 切回按店铺：两种视图都要能用
  await ui.eval(`const b = document.querySelector('[data-test="tax-view-stores"]'); if (b) b.click(); return true`)
  await sleep(400)
  const backToStores = await ui.eval(`
    return { stores: document.querySelectorAll('[data-test="tax-row"]').length,
             list: !!document.querySelector('[data-test="tax-subject-list"]') }
  `)
  check('可切回「按店铺」，两种视图互斥', backToStores.stores > 0 && !backToStores.list, JSON.stringify(backToStores))
  await ui.eval(`const b = document.querySelector('[data-test="tax-view-subject"]'); if (b) b.click(); return true`)
  await sleep(300)

  await ui.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false })
  await sleep(600)
  await ui.eval(`const el = document.querySelector('[data-test="tax-report"]'); if (el) el.scrollIntoView({ block: 'start' }); return true`)
  await sleep(400)
  const shot = await ui.send('Page.captureScreenshot', { format: 'png' })
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  fs.writeFileSync(path.join(here, '..', '..', 'assets', 'design', 'invoice-center-v1', '13-tax-report-live.png'), Buffer.from(shot.data, 'base64'))
  console.log('SHOT: assets/design/invoice-center-v1/13-tax-report-live.png')

  ui.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n通过 ${results.length - failed}/${results.length}`)
  if (failed) process.exit(1)
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
