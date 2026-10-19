/**
 * 发票中心 v2「精简版 UI」：实机验证 + 设计图重拍（连到**正在运行的**应用，只读）。
 *
 * 与 invoice-center-v1 的分工：
 *   · v1 的 capture-implemented.mjs 自己起隔离实例（种数据）；verify-live.mjs 连已开实例。
 *   · 本脚本连已开实例（默认 CDP 9250），一次做完两件事：
 *       ① 验证独立发票页面的精简版形态（默认按主体 / 概览一行 / 筛选折叠 / 明细收起 / 窄屏无横向溢出）；
 *       ② 覆盖式重拍本目录 01-desktop.png（1600×1000@2）与 02-mobile.png（414×896@2）——图随时可从真机再生。
 *
 * 用法：node assets/design/invoice-center-v2/capture-live.mjs [CDP端口]
 * 前提：应用已启动并带 --remote-debugging-port=9250（从 WorkBuddy 会话终端跑时先 unset ELECTRON_RUN_AS_NODE）。
 * 产物：01-desktop.png / 02-mobile.png；退出码 0 = 全部检查通过。
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
  try {
    await ui.send('Runtime.enable')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)

    const locked = await ui.eval(`return !!document.querySelector('.lock-overlay')`)
    if (locked) { console.log('NOTE - 应用处于锁屏状态，先解锁再运行本脚本'); return }

    // 进独立「发票中心」页面；不在工作台时先点一个店铺卡进去
    await ui.eval(`
      const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
      if (nav) nav.click()
      return true
    `)
    await sleep(1200)
    let invoiceReady = await ui.eval(`return !!document.querySelector('[data-test="invoice-license-bar"]')`)
    if (!invoiceReady) {
      await ui.eval(`const c = document.querySelector('[data-test="store-card"]'); if (c) c.click(); return true`)
      await sleep(2500)
      await ui.eval(`
        const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
        if (nav) nav.click()
        return true
      `)
    }
    await until(() => ui.eval(`return !!document.querySelector('[data-test="invoice-license-bar"]')`), 12000, 'invoice center')
    check('独立侧栏「发票中心」页面渲染正常', true)

    // 1) 默认视图 = 按主体（分组层级：主体 → 下属店铺）
    const groupCount = await until(() => ui.eval(`return document.querySelectorAll('[data-test^="invoice-subject-group-"]').length`), 15000, 'subject groups').catch(() => 0)
    check('默认视图=「按主体」：直接看到主体分组', groupCount > 0, `groups=${groupCount}`)

    const groups = await ui.eval(`
      const list = [...document.querySelectorAll('[data-test^="invoice-subject-group-"]')]
      return list.map(g => {
        // 行选择器必须带 [role="button"]：flag/fill 子元素也用 invoice-subject-store- 前缀
        const rows = [...g.querySelectorAll('[data-test^="invoice-subject-store-"][role="button"]')]
        const figs = (g.querySelector('.inv-subject-figs')?.textContent || '').replace(/\\s+/g, ' ').trim()
        return {
          key: (g.getAttribute('data-test') || '').replace('invoice-subject-group-', ''),
          name: (g.querySelector('.inv-subject-name b')?.textContent || '').trim(),
          figs,
          storeCount: Number((figs.match(/(\\d+) 家店/) || [])[1] || -1),
          rows: rows.length,
          names: rows.map(s => (s.querySelector('.inv-subject-store-name b')?.textContent || '').trim()),
          allEnter: rows.length > 0 && rows.every(s => !!s.querySelector('.inv-subject-enter'))
        }
      })
    `)
    const countsMatch = groups.length > 0 && groups.every(g => g.storeCount === g.rows && g.rows > 0)
    check('每个主体：店铺行数 = 组头家数，且每行都有「进入店铺 →」',
      countsMatch && groups.every(g => g.allEnter),
      groups.map(g => `${g.name}=${g.rows}/${g.storeCount}${g.allEnter ? '' : '(缺入口)'}`).join(' | '))
    const noneIdx = groups.findIndex(g => g.key === '__none__')
    check('「未填写营业执照」存在时固定最后', noneIdx === -1 || noneIdx === groups.length - 1, `noneIdx=${noneIdx} total=${groups.length}`)

    // 2) 概览一行（含自动更新开关与刷新入口）
    const brief = await ui.eval(`
      const strip = document.querySelector('[data-test="invoice-totals"]')
      const nums = strip ? [...strip.querySelectorAll('.dc-num')].map(x => (x.textContent || '').trim()) : []
      const panel = document.querySelector('[data-test="invoice-filter-panel"]')
      const schedule = document.querySelector('[data-test="invoice-schedule"]')
      return {
        nums,
        kpiNotes: strip ? strip.querySelectorAll('.inv-kpi-note').length : -1,
        panelHidden: panel ? getComputedStyle(panel).display === 'none' : false,
        refresh: !!document.querySelector('[data-test="invoice-refresh"]'),
        schedule: !!schedule,
        scheduleActive: schedule?.getAttribute('data-active') || null,
        notes: document.querySelectorAll('[data-test="invoice-pending-note"], [data-test="invoice-unparsed-note"]').length
      }
    `)
    check('概览合并为一行：恰 3 个数字（待开票 / 金额 / 店铺，顺序固定）',
      brief.nums.length === 3 && brief.nums.every(n => n.length > 0), JSON.stringify(brief.nums))
    check('旧式 KPI 卡与两条说明段落已退场（说明收进 chip title）',
      brief.kpiNotes === 0 && brief.notes === 0, JSON.stringify({ kpiNotes: brief.kpiNotes, notes: brief.notes }))
    check('概览行含「自动更新」开关且状态如实（data-active）', brief.schedule && brief.scheduleActive !== null, `data-active=${brief.scheduleActive}`)
    check('概览行提供「刷新」入口', brief.refresh === true)
    check('筛选默认收起', brief.panelHidden === true)

    // 3) 筛选展开 → 4 个下拉 → 复原收起
    await ui.eval(`document.querySelector('[data-test="invoice-filter-toggle"]').click(); return true`)
    const panelOpen = await until(() => ui.eval(`return getComputedStyle(document.querySelector('[data-test="invoice-filter-panel"]')).display !== 'none'`), 4000, 'filter panel').catch(() => false)
    const selectCount = await ui.eval(`return document.querySelectorAll('[data-test="invoice-filter-panel"] select').length`)
    check('点「筛选」展开 状态/平台/采集时间/排序 四个下拉', !!panelOpen && selectCount === 4, `open=${!!panelOpen} selects=${selectCount}`)
    await ui.eval(`document.querySelector('[data-test="invoice-filter-toggle"]').click(); return true`)
    await sleep(300)

    // 4) 方向明细：默认收起、点开才渲染（「按店铺」视图）；验证后复原
    await ui.eval(`document.querySelector('[data-test="invoice-view-stores"]').click(); return true`)
    await sleep(400)
    const dirBefore = await ui.eval(`return document.querySelectorAll('[data-test="invoice-section"]').length`)
    await ui.eval(`const t = document.querySelector('[data-test^="invoice-dir-toggle-"]'); if (t) t.click(); return true`)
    const sectionsAfter = await until(() => ui.eval(`const n = document.querySelectorAll('[data-test="invoice-section"]').length; return n > 0 ? n : 0`), 5000, 'dir sections').catch(() => 0)
    check('方向明细默认收起、点开才渲染（首屏更干净）', dirBefore === 0 && sectionsAfter > 0, `before=${dirBefore} after=${sectionsAfter}`)
    await ui.eval(`const t = document.querySelector('[data-test^="invoice-dir-toggle-"]'); if (t) t.click(); return true`)
    await sleep(250)
    await ui.eval(`document.querySelector('[data-test="invoice-view-summary"]').click(); return true`)
    await sleep(400)

    // 5) 窄屏（414px）无横向溢出 —— 本版修掉的真实缺陷，固化为断言
    await ui.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: false })
    await sleep(900)
    const overflow = await ui.eval(`
      const p = document.querySelector('.unified-page')
      if (!p) return null
      return { scrollW: p.scrollWidth, clientW: p.clientWidth, ok: p.scrollWidth <= p.clientWidth + 2 }
    `)
    check('窄屏 414px 页面级无横向溢出', overflow?.ok === true, JSON.stringify(overflow))

    // 6) 重拍两档（覆盖式）
    await ui.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false })
    await sleep(900)
    await ui.eval(`const el = document.querySelector('.unified-page'); if (el) el.scrollTop = 0; return true`)
    await sleep(300)
    const shot1 = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(HERE, '01-desktop.png'), Buffer.from(shot1.data, 'base64'))
    check('桌面拍摄 01-desktop.png', true)

    await ui.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: false })
    await sleep(900)
    await ui.eval(`const el = document.querySelector('.unified-page'); if (el) el.scrollTop = 0; return true`)
    await sleep(300)
    const shot2 = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(HERE, '02-mobile.png'), Buffer.from(shot2.data, 'base64'))
    check('移动拍摄 02-mobile.png', true)

    check('渲染层没有 console 错误', ui.consoleErrors.length === 0, ui.consoleErrors.slice(0, 3).join(' | '))

    const failed = results.filter(r => !r.ok)
    console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
    console.log(`产物：${path.join(HERE, '01-desktop.png')} / 02-mobile.png`)
    if (failed.length) process.exit(1)
  } finally {
    try { await ui.send('Emulation.clearDeviceMetricsOverride') } catch { /* 窗口可能已关 */ }
    ui.close()
  }
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
