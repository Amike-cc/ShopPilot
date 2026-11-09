/**
 * 发票/涉税后台采集历史验收（2026-11-10 / 0.9.12）
 *
 * 1) 创建并运行一条「发票采集 ·」后台任务，产生 run；
 * 2) overview.collectionHistory('invoice') 返回该 run（状态/错误字段原样）；
 * 3) 发票页「采集记录」浮层显示这条记录；
 * 4) 非法 domain 被拒绝。
 *
 * 运行：node tools/acceptance/collection-history-cdp-verify.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_HISTORY_CDP_PORT || 9408)
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

async function findUi(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
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

async function click(ui, selector) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, reason: 'not found' }
    el.click()
    return { ok: true }
  `)
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-collection-history-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const packaged = process.env.SHOPILOT_ACCEPTANCE_PACKAGED === '1'
  const args = [...(packaged ? [] : [ROOT]), '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`]
  const child = spawn(RUNTIME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  let ui = null
  try {
    ui = await findUi()
    await sleep(900)
    const store = await ui.eval(`return await window.shopilot.store.create({ name: '采集历史验收店', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com' })`)
    if (!store.ok) throw new Error('创建店铺失败：' + JSON.stringify(store.error))
    const storeId = store.data.id
    await ui.eval(`return await window.shopilot.browser.open(${JSON.stringify(storeId)})`)
    await sleep(2000)
    const task = await ui.eval(`return await window.shopilot.task.create({ name: '发票采集 · 历史验收', storeScope: ${JSON.stringify(storeId)}, steps: [{ type: 'waitMs', input: { ms: 200 } }], kind: 'custom', source: 'manual' })`)
    if (!task.ok) throw new Error('创建后台任务失败：' + JSON.stringify(task.error))
    const run = await ui.eval(`return await window.shopilot.task.run(${JSON.stringify(task.data.id)})`)
    check('创建并触发后台采集任务', run.ok === true, JSON.stringify(run.error || run.data))
    await sleep(3500)
    const history = await ui.eval(`return await window.shopilot.overview.collectionHistory('invoice', 20)`)
    check('采集历史返回真实 run（含状态/错误字段）', history.ok === true && Array.isArray(history.data) && history.data.some(row => row.taskName.includes('历史验收')),
      JSON.stringify({ count: history.data?.length, first: history.data?.[0] }))

    const invalid = await ui.eval(`return await window.shopilot.overview.collectionHistory('orders', 20)`)
    check('非法采集域被拒绝', invalid.ok === false, JSON.stringify(invalid.error))

    await click(ui, '[data-test="nav-invoices"]')
    await sleep(900)
    const open = await click(ui, '[data-test="collection-history-open"]')
    await sleep(700)
    const dialogText = await ui.eval(`return document.querySelector('[data-test="collection-history-dialog"]')?.textContent || ''`)
    check('发票页采集记录浮层显示记录', open.ok && dialogText.includes('采集记录') && dialogText.includes('历史验收'), dialogText.slice(0, 160))
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
