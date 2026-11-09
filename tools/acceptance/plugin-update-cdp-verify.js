/**
 * 应用商城·插件更新提示验收（2026-11-10 / 0.9.8）
 *
 * 1) 首次启动安装内置插件；
 * 2) 退出后把本机已装清单版本改旧（0.0.1）；
 * 3) 再次启动，商城卡片应显示「可更新 v0.0.1 → v<目录版本>」和「更新到 v…」；
 * 4) 点击更新后已装版本回到目录版本、更新提示消失。
 *
 * 运行：node tools/acceptance/plugin-update-cdp-verify.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_PLUGIN_CDP_PORT || 9396)
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

function launch(userData) {
  const packaged = process.env.SHOPILOT_ACCEPTANCE_PACKAGED === '1'
  const args = [...(packaged ? [] : [ROOT]), '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`]
  const child = spawn(RUNTIME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

function stop(child) {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
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
  const userData = path.join(os.tmpdir(), 'shopilot-plugin-update-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)

  let child = launch(userData)
  let ui = null
  let entry = null
  try {
    ui = await findUi()
    await sleep(900)
    const catalog = await ui.eval(`return await window.shopilot.extensions.catalog()`)
    entry = catalog.ok ? catalog.data?.entries?.[0] : null
    if (!entry) throw new Error('内置插件目录为空')
    const installed = await ui.eval(`return await window.shopilot.extensions.installFromCatalog(${JSON.stringify(entry.key)})`)
    check('首次安装内置插件', installed.ok === true, JSON.stringify({ key: entry.key, id: entry.id, version: entry.version }))
  } finally {
    if (ui) ui.close()
    stop(child)
    await sleep(1200)
  }

  const manifestPath = path.join(userData, 'extensions', String(entry.id), 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('找不到已安装插件清单：' + manifestPath)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.version = '0.0.1'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  child = launch(userData)
  ui = null
  try {
    ui = await findUi()
    await sleep(900)
    await click(ui, '[data-test="nav-apps"]')
    await sleep(900)
    const badge = await ui.eval(`return document.querySelector('[data-test="apps-plugin-update-badge"]')?.textContent || ''`)
    const button = await ui.eval(`return document.querySelector('[data-test="apps-plugin-install-${entry.key}"]')?.textContent || ''`)
    check('商城显示本地版本可更新', badge.includes('0.0.1') && badge.includes(entry.version) && button.includes(`更新到 v${entry.version}`),
      JSON.stringify({ badge, button }))
    await click(ui, `[data-test="apps-plugin-install-${entry.key}"]`)
    await sleep(1600)
    const list = await ui.eval(`return await window.shopilot.extensions.list()`)
    const installedNow = list.ok ? list.data.items.find(item => item.id === entry.id)?.version : null
    const badgeAfter = await ui.eval(`return !!document.querySelector('[data-test="apps-plugin-update-badge"]')`)
    check('更新后版本回到目录版本且提示消失', installedNow === entry.version && badgeAfter === false,
      JSON.stringify({ installedNow, badgeAfter }))
  } finally {
    if (ui) ui.close()
    stop(child)
  }

  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('失败项：' + failed.map(item => item.name).join('；'))
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('验收异常：', error?.stack || error)
  process.exitCode = 1
})
