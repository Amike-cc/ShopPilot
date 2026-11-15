/**
 * 核心修复批次验收（2026-11-09 / 0.9.4）
 *
 * 覆盖：
 *   1) 数据分析聚合：任务快照兜底、周期筛选不再把快照冒充成周期数据；
 *   2) 数据分析 UI：周期/平台工具条、来源/口径列、平台对比、导出按钮存在；
 *   3) 指纹 IPC：更新 / 锁定后拒绝更新 / 解锁；
 *   4) 模块卸载后经营总览不再露出 AI 入口（侧栏与卡片）。
 *
 * 前置：用独立 userData 启动，避免动用户当前库。
 * 运行：node tools/acceptance/core-fixes-cdp-verify.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_CORE_FIX_CDP_PORT || 9380)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(body, timeoutMs = 20000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error(`页面求值超时：${String(body).replace(/\s+/g, ' ').slice(0, 100)}`)
    if (result.exceptionDetails) throw new Error('页面异常：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
}

async function findUi(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await targets()
      const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        const cdp = new CDP(target.webSocketDebuggerUrl)
        await cdp.ready
        return cdp
      }
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('主窗口 CDP 未就绪')
}

async function waitForText(ui, text, timeoutMs = 6000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const body = await ui.eval('return document.body.innerText')
    if (String(body || '').includes(text)) return true
    await sleep(250)
  }
  return false
}

async function click(ui, selector) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, reason: 'not found' }
    el.click()
    return { ok: true }
  `)
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-core-fixes-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const packaged = process.env.SHOPILOT_ACCEPTANCE_PACKAGED === '1'
  const appArgs = [...(packaged ? [] : [ROOT]), '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`]
  const child = spawn(RUNTIME, appArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  let ui = null
  try {
    ui = await findUi()
    await sleep(1000)

    const created = await ui.eval(`return await window.shopilot.store.create({ name: '验收数据店', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com' })`)
    if (!created.ok) throw new Error('创建店铺失败：' + JSON.stringify(created.error))
    const storeId = created.data.id
    await ui.eval(`return await window.shopilot.overview.manualMetric(${JSON.stringify(storeId)}, 'biz.gmv', 123.45)`)
    await ui.eval(`return await window.shopilot.overview.manualMetric(${JSON.stringify(storeId)}, 'biz.orders', 7)`)

    const all = await ui.eval(`return await window.shopilot.overview.analytics({ periodType: 'ALL' })`)
    const allRow = all.ok ? all.data.rows.find(row => row.storeId === storeId) : null
    check('ALL：任务快照兜底并标记来源/口径', all.ok && allRow?.source === 'SNAPSHOT' && allRow?.periodLabel === '任务快照' && allRow?.values['biz.gmv'] === 123.45 && allRow?.values['biz.orders'] === 7,
      JSON.stringify({ source: allRow?.source, gmv: allRow?.values?.['biz.gmv'], orders: allRow?.values?.['biz.orders'] }))

    const today = await ui.eval(`return await window.shopilot.overview.analytics({ periodType: 'TODAY' })`)
    const todayRow = today.ok ? today.data.rows.find(row => row.storeId === storeId) : null
    check('TODAY：没有自动采集时不把任务快照冒充成今日', today.ok && todayRow?.source === 'NONE',
      JSON.stringify({ source: todayRow?.source }))

    await click(ui, '[data-test="nav-analytics"]')
    await sleep(700)
    check('数据分析页：工具条与导出按钮出现', await ui.eval(`return !!document.querySelector('[data-test="analytics-toolbar"]') && !!document.querySelector('[data-test="analytics-export"]')`))
    check('数据分析表：显示店铺 / 来源 / 任务快照 / 金额', await waitForText(ui, '验收数据店') && await waitForText(ui, '任务快照') && await waitForText(ui, '123.45'))
    check('平台对比卡出现', await ui.eval(`return !!document.querySelector('[data-test="analytics-platform-compare"]')`))

    await ui.eval(`
      const buttons = [...document.querySelectorAll('[data-test="analytics-toolbar"] button')]
      const target = buttons.find(button => button.textContent.trim() === '今日')
      if (target) target.click()
      return !!target
    `)
    await sleep(900)
    check('切到「今日」后空态如实说明（不伪造数据）', await waitForText(ui, '当前范围没有经营指标'))

    await ui.eval(`
      const buttons = [...document.querySelectorAll('[data-test="analytics-toolbar"] button')]
      const target = buttons.find(button => button.textContent.trim() === '各平台最新')
      if (target) target.click()
      return !!target
    `)
    await sleep(700)

    const profile0 = await ui.eval(`return await window.shopilot.profile.get(${JSON.stringify(storeId)})`)
    check('读取环境指纹', profile0.ok === true && !!profile0.data?.userAgent)
    const updated = await ui.eval(`return await window.shopilot.profile.update(${JSON.stringify(storeId)}, { timezone: 'America/New_York' })`)
    check('修改环境指纹', updated.ok === true && updated.data?.timezone === 'America/New_York')
    const locked = await ui.eval(`return await window.shopilot.profile.lock(${JSON.stringify(storeId)}, true)`)
    const blocked = await ui.eval(`return await window.shopilot.profile.update(${JSON.stringify(storeId)}, { timezone: 'Asia/Tokyo' })`)
    check('锁定后拒绝修改', locked.ok === true && blocked.ok === false && String(blocked.error?.code || '').includes('PROFILE_LOCKED'),
      JSON.stringify({ code: blocked.error?.code }))
    const unlocked = await ui.eval(`return await window.shopilot.profile.lock(${JSON.stringify(storeId)}, false)`)
    const restored = await ui.eval(`return await window.shopilot.profile.update(${JSON.stringify(storeId)}, { timezone: 'Asia/Shanghai' })`)
    check('解锁后可以恢复修改', unlocked.ok === true && restored.ok === true && restored.data?.timezone === 'Asia/Shanghai')

    // 指纹编辑真机：打开店铺工作区 → 右侧「环境」→ 编辑指纹 → 锁定/解锁
    await click(ui, '[data-test="nav-stores"]')
    await sleep(700)
    const openedWorkspace = await ui.eval(`
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim().includes('打开工作区'))
      if (button) button.click()
      return !!button
    `)
    await sleep(1200)
    const envTab = await ui.eval(`
      const tabs = [...document.querySelectorAll('[data-test="right-panel"] [role="tab"]')]
      const tab = tabs.find(item => item.textContent.trim().includes('环境'))
      if (tab) tab.click()
      return !!tab
    `)
    await sleep(400)
    check('环境页显示主进程会话状态', await ui.eval(`
      const node = document.querySelector('[data-test="session-state"]')
      return !!node && node.textContent.includes('会话状态')
    `))
    const editorOpened = await click(ui, '[data-test="profile-edit"]')
    await sleep(500)
    check('指纹编辑 UI：工作区环境页可打开编辑器并带出当前 UA', openedWorkspace && envTab && editorOpened.ok
      && await ui.eval(`return !!document.querySelector('[data-test="profile-editor"]') && !!document.querySelector('[data-test="profile-user-agent"]')?.value`))
    await click(ui, '[data-test="profile-lock"]')
    await sleep(500)
    check('指纹编辑 UI：锁定后输入框禁用', await ui.eval(`
      const state = document.querySelector('.env-lock-state')?.textContent.trim()
      const input = document.querySelector('[data-test="profile-user-agent"]')
      return state === '已锁定' && input?.disabled === true
    `))
    await click(ui, '[data-test="profile-lock"]')
    await sleep(400)

    // 代理凭据边界：改 host 后旧账号密码必须被清空，不能跟着"搬"到新主机
    const proxyCreated = await ui.eval(`return await window.shopilot.proxy.create({ type: 'socks5', host: '127.0.0.1', port: 9, label: '凭据作用域验收' }, 'user', 'pass')`)
    const proxyUpdated = proxyCreated.ok
      ? await ui.eval(`return await window.shopilot.proxy.update(${JSON.stringify(proxyCreated.data.id)}, { host: '127.0.0.2' })`)
      : null
    check('代理改地址后旧凭据被清空', proxyCreated.ok && proxyCreated.data?.hasCredential === true && proxyUpdated?.ok === true && proxyUpdated.data?.hasCredential === false,
      JSON.stringify({ before: proxyCreated.data?.hasCredential, after: proxyUpdated?.data?.hasCredential }))
    if (proxyCreated.ok) await ui.eval(`return await window.shopilot.proxy.delete(${JSON.stringify(proxyCreated.data.id)})`)

    const off = await ui.eval(`return await window.shopilot.settings.set('ui.apps.installedModules', ['invoices','tax'])`)
    check('写入模块卸载状态', off.ok === true)
    await ui.eval('location.reload(); return true')
    await sleep(1800)
    await click(ui, '[data-test="nav-overview"]')
    await sleep(800)
    const bodyAfter = await ui.eval('return document.body.innerText')
    const navAi = await ui.eval(`return !!document.querySelector('[data-test="nav-ai"]')`)
    const invoiceCard = await ui.eval(`return !!document.querySelector('#invoice-todo')`)
    check('AI 卸载后总览不再显示 AI 入口/卡片', !String(bodyAfter).includes('AI 电商助手') && !String(bodyAfter).includes('问问 AI') && navAi === false)
    check('AI 卸载后发票待办仍在（未卸载）', invoiceCard === true && String(bodyAfter).includes('待开发票'))
    check('经营总览不再显示假的自定义日期', !String(bodyAfter).includes('自定义日期'))

    await ui.eval(`return await window.shopilot.settings.set('ui.apps.installedModules', ['invoices','tax','ai-assistant','ai-chat-image'])`)
  } finally {
    if (ui) ui.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }

  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('失败项：' + failed.map(item => item.name).join('；'))
    if (appLog) console.log('应用日志尾部：\n' + appLog.slice(-2000))
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('验收异常：', error?.stack || error)
  process.exitCode = 1
})
