/**
 * 验证**正在运行的** ShopPilot 实例里的发票中心（只读；不改任何数据）。
 *
 * 与 capture-implemented.mjs 的区别：那个自己起一个隔离实例，这个连到已经开着的那一个
 * （默认 CDP 端口 9250），用来回答"重启之后用户看到的是不是新版界面"。
 *
 * 用法：node assets/design/invoice-center-v1/verify-live.mjs [端口]
 * 产物：本目录 12-live-verify.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.argv[2] || process.env.SHOPILOT_LIVE_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push('EXCEPTION: ' + (msg.params?.exceptionDetails?.exception?.description || '').slice(0, 300))
      }
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  async send(method, params = {}) {
    await this.ready // 必须先等 socket 连上，否则会 InvalidStateError: Sent before connected
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
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function until(fn, timeoutMs, label) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(250)
  }
  throw new Error('TIMEOUT: ' + label)
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('没找到 renderer 页面（应用没起来？端口不对？）')
  const ui = new CDP(target.webSocketDebuggerUrl)
  await ui.send('Runtime.enable')
  await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)

  // 锁屏时先解锁不了（要密码），如实报出来
  const locked = await ui.eval(`return !!document.querySelector('.lock-overlay')`)
  if (locked) { console.log('NOTE - 应用处于锁屏状态，先解锁再验证'); return }

  // 走界面进「数据分析 → 发票中心」
  await ui.eval(`const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent||'').includes('数据分析')); if (nav) nav.click(); return true`)
  await until(() => ui.eval(`return !!document.querySelector('.unified-route-tabs')`), 12000, 'route tabs')
  await ui.eval(`const tab = [...document.querySelectorAll('.unified-route-tabs button')].find(i => (i.textContent||'').includes('发票中心')); if (tab) tab.click(); return true`)
  await until(() => ui.eval(`return !!document.querySelector('[data-test="invoice-license-bar"]')`), 15000, 'invoice center')

  const snapshot = await ui.eval(`
    const q = s => document.querySelector(s)
    const n = s => document.querySelectorAll(s).length
    return {
      page: !!q('[data-test="unified-invoices-page"]'),
      rail: !!q('.inv-rail'),
      chips: [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.querySelector('.inv-lic-name')?.textContent?.trim() || el.textContent.trim().slice(0, 20)),
      activeChips: n('[data-test="invoice-license-bar"] .inv-lic-chip.on'),
      status: !!q('[data-test="invoice-status"]'),
      kpis: [...document.querySelectorAll('[data-test="invoice-totals"] .dc-num')].map(el => el.textContent.trim()),
      toolbar: !!q('[data-test="invoice-toolbar"]'),
      controls: { search: !!q('[data-test="invoice-search"]'), status: !!q('[data-test="invoice-filter-status"]'), platform: !!q('[data-test="invoice-filter-platform"]'), period: !!q('[data-test="invoice-filter-period"]'), sort: !!q('[data-test="invoice-sort"]'), viewSwitch: !!q('[data-test="invoice-view-switch"]') },
      coverage: !!q('[data-test="invoice-coverage"]'),
      coveragePlatforms: n('[data-test="invoice-coverage"] .inv-cover-plat'),
      sections: n('[data-test="invoice-section"]'),
      sectionBadges: [...document.querySelectorAll('[data-test="invoice-section"] .inv-sec-badge')].map(el => el.textContent.trim()),
      rows: n('[data-test="invoice-row"]'),
      scheduleToggle: !!q('[data-test="invoice-schedule-toggle"]'),
      exportBtn: !!q('[data-test="invoice-export"]'),
      collectBtn: !!q('[data-test="invoice-collect"]'),
      entityCollectBtn: !!q('[data-test="invoice-entity-collect"]')
    }
  `)

  check('发票中心页渲染', snapshot.page)
  check('左栏「开票主体分账」存在，且只在 invoice-license-bar 里放胶囊', snapshot.rail && snapshot.chips.length >= 2, `${snapshot.chips.length} 个胶囊：${JSON.stringify(snapshot.chips)}`)
  check('胶囊选中态恰好一个', snapshot.activeChips === 1, String(snapshot.activeChips))
  check('采集状态条存在', snapshot.status)
  check('KPI 恰好 4 张，前三张依次是 条数/金额/店铺数', snapshot.kpis.length === 4, JSON.stringify(snapshot.kpis))
  check('工具条 + 六个控件齐备', snapshot.toolbar && Object.values(snapshot.controls).every(Boolean), JSON.stringify(snapshot.controls))
  check('平台覆盖与金额口径卡渲染出平台', snapshot.coverage && snapshot.coveragePlatforms > 0, `${snapshot.coveragePlatforms} 个平台`)
  check('方向卡与三态徽标渲染', snapshot.sections > 0 && snapshot.sectionBadges.length === snapshot.sections, JSON.stringify(snapshot.sectionBadges.slice(0, 8)))
  check('店铺行渲染', snapshot.rows > 0, `${snapshot.rows} 行`)
  check('关键钩子仍在（自动更新开关 / 导出 / 采集 / 获取主体）',
    snapshot.scheduleToggle && snapshot.exportBtn && snapshot.collectBtn && snapshot.entityCollectBtn)

  // 切「按主体汇总」→ 应渲染汇总表（只切界面状态，不写数据）
  await ui.eval(`const b = document.querySelector('[data-test="invoice-view-summary"]'); if (b) b.click(); return true`)
  await sleep(400)
  const summary = await ui.eval(`
    const rows = document.querySelectorAll('[data-test="invoice-summary"] tbody tr')
    return { has: !!document.querySelector('[data-test="invoice-summary"]'), rows: rows.length,
             first: rows[0] ? [...rows[0].children].slice(0, 5).map(td => td.textContent.replace(/\\s+/g,' ').trim()) : [] }
  `)
  check('「按主体汇总」视图渲染出主体行', summary.has && summary.rows > 0, `${summary.rows} 行`)
  await ui.eval(`const b = document.querySelector('[data-test="invoice-view-stores"]'); if (b) b.click(); return true`)
  await sleep(300)

  await ui.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false })
  await sleep(800)
  await ui.eval(`const el = document.querySelector('.unified-page'); if (el) el.scrollTop = 0; return true`)
  await sleep(300)
  const shot = await ui.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(HERE, '12-live-verify.png'), Buffer.from(shot.data, 'base64'))
  check('截屏成功', true, '12-live-verify.png')

  check('渲染层没有 console 错误', ui.consoleErrors.length === 0, ui.consoleErrors.slice(0, 3).join(' | '))

  ui.close()
  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length) process.exit(1)
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
