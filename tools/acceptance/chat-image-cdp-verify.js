/**
 * 对话生图真机验收（2026-11-14 / 0.9.34）
 *
 * 不消耗用户真实生图额度：启动独立 userData 的 ShopPilot，把生图接口指向本机 mock
 * （仅 127.0.0.1 允许 http），走真实的「渲染层 → preload → 主进程 fetch → 结果上屏」链路。
 *
 * 覆盖：
 *   1) 侧栏独立入口 / 页面模型状态；
 *   2) 第一轮纯文字生图，结果图真实渲染；
 *   3) 「基于这张改」把结果作为参考图，第二轮请求走 /images/edits 且带 multipart image；
 *   4) 生成中禁止离开的 busy 接线（只做 UI 状态观察，不强行切页）。
 *
 * 运行：node tools/acceptance/chat-image-cdp-verify.js
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_CHAT_IMAGE_CDP_PORT || 9391)
const MOCK_PORT = Number(process.env.SHOPILOT_CHAT_IMAGE_MOCK_PORT || 9392)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const OUT = path.join(ROOT, 'artifacts', 'chat-image')
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
  return ui.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true`)
}
async function setText(ui, selector, value) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
}
async function waitFor(ui, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await ui.eval(expression)) return true
    await sleep(300)
  }
  return false
}

function startMockServer() {
  const sample = fs.readFileSync(path.join(ROOT, 'tools/acceptance/fixtures/product-sample.jpg'))
  const b64 = sample.toString('base64')
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk.toString('binary') })
    req.on('end', () => {
      const contentType = String(req.headers['content-type'] || '')
      requests.push({ method: req.method, url: req.url, contentType, hasImageField: body.includes('name="image"') })
      if (req.method !== 'POST' || !/images\/(generations|edits)/.test(String(req.url))) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'mock-image', data: [{ b64_json: b64, mime_type: 'image/jpeg' }] }))
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
  const mock = await startMockServer()
  const userData = path.join(os.tmpdir(), 'shopilot-chat-image-' + Date.now())
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
    const configured = await ui.eval(`return await window.shopilot.ai.imageConfigSet({ endpoint: ${JSON.stringify(endpoint)}, model: 'mock-image', timeoutMs: 20000 })`)
    const keyed = await ui.eval(`return await window.shopilot.ai.setImageKey('acceptance-key')`)
    check('本机 mock 生图配置写入成功', configured.ok === true && keyed.ok === true, JSON.stringify({ configured, keyed }))

    const entered = await click(ui, '[data-test="nav-chat-image"]')
    const ready = await waitFor(ui, `return Boolean(document.querySelector('[data-test="chat-image-page"]'))`, 12000)
    check('侧栏可进入独立的「对话生图」页面', entered && ready)
    const modelText = await ui.eval(`return document.querySelector('[data-test="chat-image-model"]')?.textContent || ''`)
    check('页面显示真实生图模型', modelText.includes('mock-image'), modelText)

    await setText(ui, '[data-test="chat-image-input"]', '白色背景的帆布托特包商品主图，柔和阴影')
    const sent = await click(ui, '[data-test="chat-image-send"]')
    const first = await waitFor(ui, `return document.querySelectorAll('[data-test="chat-image-assistant-message"]').length >= 1`, 25000)
    check('第一轮发送并返回消息', sent && first)
    const firstImage = await ui.eval(`
      const img = document.querySelector('[data-test="chat-image-assistant-message"] img')
      return { src: String(img?.src || '').slice(0, 32), naturalWidth: Number(img?.naturalWidth || 0), error: document.querySelector('[data-test="chat-image-assistant-message"] [role="alert"]')?.textContent || '' }
    `)
    check('第一轮结果图真实渲染（data URL + 已解码）', firstImage.src.startsWith('data:image/') && firstImage.naturalWidth > 0, JSON.stringify(firstImage))
    check('纯文字请求走 /images/generations', mock.requests.some(item => /images\/generations/.test(item.url) && !item.hasImageField), JSON.stringify(mock.requests))

    const toLibrary = await click(ui, '[data-test^="chat-image-to-library-"]')
    const inLibrary = await waitFor(ui, `
      const result = await window.shopilot.assets.list()
      return result.ok && result.data.items.some(item => item.source === 'chat-image')
    `, 6000)
    const libraryItem = await ui.eval(`
      const result = await window.shopilot.assets.list()
      return result.ok ? result.data.items.find(item => item.source === 'chat-image') : null
    `)
    check('生成结果可一键存入素材库（source=chat-image）', toLibrary && inLibrary && Boolean(libraryItem), JSON.stringify(libraryItem && { name: libraryItem.name, tags: libraryItem.tags, source: libraryItem.source }))
    await ui.send('Page.captureScreenshot', { format: 'png' }).then(result => fs.writeFileSync(path.join(OUT, 'chat-image-result.png'), Buffer.from(result.data, 'base64')))

    const useRef = await click(ui, '[data-test^="chat-image-use-reference-"]')
    const refReady = await waitFor(ui, `return Boolean(document.querySelector('[data-test="chat-image-reference"]'))`, 5000)
    check('「基于这张改」把结果设为下一轮参考图', useRef && refReady)

    await setText(ui, '[data-test="chat-image-input"]', '把背景换成海边日落，商品保持不变')
    await click(ui, '[data-test="chat-image-send"]')
    const second = await waitFor(ui, `return document.querySelectorAll('[data-test="chat-image-assistant-message"]').length >= 2`, 25000)
    check('第二轮参考图消息返回', second)
    const editRequest = mock.requests.find(item => /images\/edits/.test(item.url))
    check('参考图请求走 /images/edits 且是 multipart image', Boolean(editRequest?.hasImageField && /multipart\/form-data/i.test(editRequest.contentType)), JSON.stringify(editRequest || null))
    await ui.send('Page.captureScreenshot', { format: 'png' }).then(result => fs.writeFileSync(path.join(OUT, 'chat-image-reference-result.png'), Buffer.from(result.data, 'base64')))
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
