/**
 * 图文带货重设计结果页真机验收（2026-11-15）
 *
 * 本机 mock 文案 + 生图接口，走真实渲染层→preload→主进程链路，不消耗用户额度：
 *   · 上传商品图、填商品名 → 生成 4 张；
 *   · 验证新的结果页（封面大字预览 + 胶片条 + 文案卡）；
 *   · 截图 artifacts/graphic-sell/redesign-result.png。
 *
 * 运行：node tools/acceptance/graphic-sell-result-cdp-verify.js
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_GRAPHIC_RESULT_CDP_PORT || 9394)
const MOCK_PORT = Number(process.env.SHOPILOT_GRAPHIC_RESULT_MOCK_PORT || 9395)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const OUT = path.join(ROOT, 'artifacts', 'graphic-sell')
const SAMPLE_IMAGE = path.join(ROOT, 'tools/acceptance/fixtures/product-sample.jpg')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id) { this.events.push(message); return }
      if (!this.pending.has(message.id)) return
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

async function setText(ui, selector, value) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}
async function waitFor(ui, expression, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await ui.eval(expression)) return true
    await sleep(250)
  }
  return false
}

function startMock() {
  const sample = fs.readFileSync(SAMPLE_IMAGE)
  const b64 = sample.toString('base64')
  const copy = {
    title: '软糯摇粒绒，秋冬居家就穿它',
    body: '早晚温差大，孩子在家总喊冷。\n双面摇粒绒上手软糯不扎，领口和袖口收得刚好，跑跳也不灌风。\n洗过几次没有起球变形，配家居裤或外穿都合适。',
    tags: ['童装', '家居服', '秋冬穿搭'],
    coverText: '软糯不扎',
    imagePrompts: [
      '封面俯拍：儿童仰卧在浅粉床品上，全身与家居服完整入画，顶部留白',
      '上半身细节：领口、袖口与绒面纹理清晰',
      '面料特写：双面摇粒绒的绒毛与缝线',
      '居家场景：孩子侧卧，旁边一只白色小猫',
      '坐姿场景：孩子坐在床边，展示整套版型',
      '细节补充：裤脚罗纹与走线'
    ],
    model: 'mock-text',
    elapsedMs: 120
  }
  const requests = []
  const server = http.createServer((req, res) => {
    let _body = ''
    req.on('data', chunk => { _body += chunk.toString('binary') })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url })
      if (req.method === 'POST' && /chat\/completions/.test(String(req.url))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model: 'mock-text',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(copy) } }]
        }))
        return
      }
      if (req.method === 'POST' && /images\/(generations|edits)/.test(String(req.url))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'mock-image', data: [{ b64_json: b64, mime_type: 'image/jpeg' }] }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve({ server, requests }))
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const mock = await startMock()
  const userData = path.join(os.tmpdir(), 'shopilot-graphic-result-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const child = spawn(RUNTIME, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  let ui = null
  try {
    ui = await findUi()
    await ui.send('Page.enable', {})
    await sleep(1200)
    const endpoint = `http://127.0.0.1:${MOCK_PORT}/v1`
    const textCfg = await ui.eval(`return await window.shopilot.ai.imageTextConfigSet({ endpoint: ${JSON.stringify(endpoint)}, model: 'mock-text', timeoutMs: 20000 })`)
    const textKey = await ui.eval(`return await window.shopilot.ai.setImageTextKey('acceptance-key')`)
    const imageCfg = await ui.eval(`return await window.shopilot.ai.imageConfigSet({ endpoint: ${JSON.stringify(endpoint)}, model: 'mock-image', timeoutMs: 20000 })`)
    const imageKey = await ui.eval(`return await window.shopilot.ai.setImageKey('acceptance-key')`)
    check('mock 文案 / 生图配置写入成功', textCfg.ok && textKey.ok && imageCfg.ok && imageKey.ok, JSON.stringify({ textCfg: textCfg.ok, textKey: textKey.ok, imageCfg: imageCfg.ok, imageKey: imageKey.ok }))

    await ui.eval(`document.querySelector('[data-test="nav-graphic-sell"]')?.click(); return true`)
    const ready = await waitFor(ui, `return Boolean(document.querySelector('[data-test="graphic-sell-page"]'))`, 12000)
    check('进入图文带货重设计页', ready)

    const doc = await ui.send('DOM.getDocument', { depth: -1 })
    const inputNode = await ui.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-test="graphic-sell-material-input"]' })
    await ui.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [SAMPLE_IMAGE] })
    const uploaded = await waitFor(ui, `return document.querySelectorAll('.gs-materials li').length >= 1`, 8000)
    check('商品图上传成功', uploaded)

    await setText(ui, '[data-test="graphic-sell-product-name"]', '儿童加厚摇粒绒家居服')
    await setText(ui, '[data-test="graphic-sell-selling-points"]', '双面摇粒绒、柔软不扎、机洗不变形')
    // 第 1 步 → 第 2 步：AI 策划免费，不出图
    await ui.eval(`document.querySelector('[data-test="graphic-sell-generate-button"]')?.click(); return true`)
    const planned = await waitFor(ui, `return Boolean(document.querySelector('[data-test="graphic-sell-plan"]'))`, 15000)
    check('AI 策划先产出卡片脚本，不直接出图', planned && !(await ui.eval(`return Boolean(document.querySelector('[data-test="graphic-sell-active-image"]'))`)))
    const plan = await ui.eval(`
      return {
        prompts: document.querySelectorAll('[data-test^="graphic-sell-plan-prompt-"]').length,
        title: document.querySelector('[data-test="graphic-sell-edit-title"]')?.value || '',
        step: document.querySelector('.gs-wizard-step.active')?.textContent || '',
        estimate: document.querySelector('.gs-estimate')?.textContent?.trim() || ''
      }
    `)
    check('策划页可确认/修改逐图脚本与文案', plan.prompts >= 4 && plan.title.includes('摇粒绒') && plan.step.includes('AI 策划'), JSON.stringify(plan))
    const planShot = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'redesign-plan.png'), Buffer.from(planShot.data, 'base64'))

    // 第 2 步 → 第 3 步：确认出图
    const imageGate = await ui.eval(`
      const btn = document.querySelector('[data-test="graphic-sell-generate-images"]')
      return { found: Boolean(btn), disabled: btn?.disabled ?? null, warning: document.body.innerText.includes('生图接口未配置') }
    `)
    check('确认出图按钮可用（生图配置已读取）', imageGate.found && imageGate.disabled === false, JSON.stringify(imageGate))
    await ui.eval(`document.querySelector('[data-test="graphic-sell-generate-images"]')?.click(); return true`)
    const confirmOpened = await waitFor(ui, `return Boolean(document.querySelector('[data-test="graphic-sell-confirm"]'))`, 5000)
    check('出图前弹出费用确认', confirmOpened)
    await ui.eval(`document.querySelector('[data-test="graphic-sell-confirm-submit"]')?.click(); return true`)

    const result = await waitFor(ui, `return Boolean(document.querySelector('[data-test="graphic-sell-result"]')) && document.querySelectorAll('.gs-film-thumb img').length >= 4`, 40000)
    check('确认后生成 4 张配图并进入结果页', result)
    check('文案接口与生图接口都被调用', mock.requests.some(item => /chat\/completions/.test(item.url)) && mock.requests.filter(item => /images\/(generations|edits)/.test(item.url)).length >= 4, JSON.stringify(mock.requests))
    const layout = await ui.eval(`
      return {
        cover: Boolean(document.querySelector('[data-test="graphic-sell-active-image"]')),
        overlay: Boolean(document.querySelector('.gs-cover-overlay')),
        overlayText: document.querySelector('.gs-cover-overlay strong')?.textContent || '',
        film: document.querySelectorAll('.gs-film-thumb').length,
        copyTitle: document.querySelector('[data-test="graphic-sell-edit-title"]')?.value || '',
        coverEdit: document.querySelector('[data-test="graphic-sell-edit-cover"]')?.value || '',
        copyFull: Boolean(document.querySelector('[data-test="graphic-sell-copy-full"]'))
      }
    `)
    check('新结果页：封面预览 + 大字 + 胶片条 + 文案卡', layout.cover && layout.overlay && layout.film >= 4 && layout.copyFull, JSON.stringify(layout))
    check('封面大字来自文案并可直接编辑', layout.overlayText.includes('软糯不扎') && layout.coverEdit === '软糯不扎', JSON.stringify({ overlayText: layout.overlayText, coverEdit: layout.coverEdit }))
    const shot = await ui.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'redesign-result.png'), Buffer.from(shot.data, 'base64'))
  } catch (error) {
    check('验收执行未抛异常', false, String(error?.stack || error))
    console.error(appLog.split('\n').slice(-30).join('\n'))
  } finally {
    ui?.close()
    child.kill()
    mock.server.close()
  }

  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) process.exitCode = 1
}

main()
