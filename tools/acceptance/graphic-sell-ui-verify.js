/**
 * 图文带货简化界面真机验收（2026-11-15）
 *
 * 只验证 UI 结构与折叠状态，不发 AI 请求、不消耗额度：
 *   · 首屏只出现商品名称 / 卖点 / 商品图 / 效果模板；
 *   · 模特、价格、平台、风格、数量、比例藏在「更多设置」；
 *   · 展开后所有原有控件仍可用。
 *
 * 运行：node tools/acceptance/graphic-sell-ui-verify.js
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_GRAPHIC_UI_PORT || 9393)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const OUT = path.join(ROOT, 'artifacts', 'graphic-sell')
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
  async eval(body, timeoutMs = 15000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error('页面求值超时')
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const userData = path.join(os.tmpdir(), 'shopilot-graphic-ui-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const child = spawn(RUNTIME, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let ui = null
  try {
    ui = await findUi()
    await ui.send('Page.enable', {})
    await sleep(1000)
    await ui.eval(`document.querySelector('[data-test="nav-graphic-sell"]')?.click(); return true`)
    await sleep(900)
    check('进入图文带货页', await ui.eval(`return Boolean(document.querySelector('[data-test="graphic-sell-page"]'))`))
    check('首屏有商品名称、卖点、商品图、效果模板', await ui.eval(`
      return Boolean(
        document.querySelector('[data-test="graphic-sell-product-name"]') &&
        document.querySelector('[data-test="graphic-sell-selling-points"]') &&
        document.querySelector('[data-test="graphic-sell-material-dropzone"]') &&
        document.querySelector('[data-test="graphic-sell-effect-bed-lying"]')
      )
    `))
    check('高级设置默认折叠', await ui.eval(`return !document.querySelector('[data-test="graphic-sell-advanced"]')`))
    check('「更多设置」入口存在且含说明', await ui.eval(`
      const btn = document.querySelector('[data-test="graphic-sell-advanced-toggle"]')
      return Boolean(btn && btn.textContent.includes('更多设置') && btn.getAttribute('aria-expanded') === 'false')
    `))
    const before = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'graphic-sell-simple.png'), Buffer.from(before.data, 'base64'))

    await ui.eval(`document.querySelector('[data-test="graphic-sell-advanced-toggle"]')?.click(); return true`)
    await sleep(400)
    const advanced = await ui.eval(`
      return {
        visible: Boolean(document.querySelector('[data-test="graphic-sell-advanced"]')),
        model: Boolean(document.querySelector('[data-test="graphic-sell-model"]')),
        price: Boolean(document.querySelector('[data-test="graphic-sell-price"]')),
        platform: Boolean(document.querySelector('[data-test="graphic-sell-platform"]')),
        style: Boolean(document.querySelector('[data-test="graphic-sell-style"]')),
        count: Boolean(document.querySelector('[data-test="graphic-sell-image-count"]')),
        ratio: Boolean(document.querySelector('[data-test="graphic-sell-ratio"]'))
      }
    `)
    check('展开后原有高级控件全部保留', Object.values(advanced).every(Boolean), JSON.stringify(advanced))
    const after = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'graphic-sell-advanced.png'), Buffer.from(after.data, 'base64'))
    check('效果模板标注适用品类', await ui.eval(`return document.body.innerText.includes('适合童装')`))
  } catch (error) {
    check('验收执行未抛异常', false, String(error?.stack || error))
  } finally {
    ui?.close()
    child.kill()
  }
  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) process.exitCode = 1
}

main()
