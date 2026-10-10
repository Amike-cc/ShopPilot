/*
 * Local desktop probe for the customer-service/workbench boundary.
 * Uses a temporary profile and a local page so it never touches real shops.
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const port = Number(process.env.SHOPILOT_CUSTOMER_SERVICE_CDP_PORT || 9291)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
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
  async eval(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function waitForCdp() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return } catch {}
    await sleep(250)
  }
  throw new Error('CDP endpoint not ready')
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
}

async function connectUi() {
  const targets = await json(`http://127.0.0.1:${port}/json`)
  const target = targets.find(item => item.type === 'page' && item.url.includes('/renderer/index.html'))
  if (!target) throw new Error(`UI target not found: ${JSON.stringify(targets.map(item => ({ type: item.type, url: item.url })))}`)
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.eval(`
    const until = Date.now() + 20000;
    while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    return !!window.shopilot;
  `)
  return cdp
}

async function clickAt(cdp, selector) {
  const point = await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  `)
  if (!point) throw new Error(`element not found: ${selector}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return point
}

async function waitFor(cdp, body, timeout = 15000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.eval(body)
    if (last) return last
    await sleep(150)
  }
  return last
}

async function main() {
  const userData = path.join(os.tmpdir(), `shopilot-customer-service-${Date.now()}`)
  fs.mkdirSync(userData, { recursive: true })
  const site = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>customer-service-switch-probe</title></head><body><h1>probe store page</h1></body></html>')
  })
  await new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve) })
  const siteUrl = `http://127.0.0.1:${site.address().port}/`
  let app = null
  let ui = null
  try {
    app = spawn(electron, [root, '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })
    await waitForCdp()
    ui = await connectUi()
    const created = await ui.eval(`
      const result = await window.shopilot.store.create({ name: '客服切换探针店', platform: '拼多多', adminUrl: ${JSON.stringify(siteUrl)} });
      return result.ok ? result.data.id : null;
    `)
    if (!created) throw new Error('store.create failed')
    try { await ui.eval('location.reload()', false) } catch {}
    await sleep(2500)
    ui.close()
    ui = await connectUi()
    await waitFor(ui, `return !![...document.querySelectorAll('[data-test="store-card"]')].find(el => el.textContent.includes('客服切换探针店'))`)
    await clickAt(ui, '[data-test="store-card"] .store-action')
    await waitFor(ui, `return !!document.querySelector('.dashboard-browser-webview.active')`, 12000)
    await sleep(500)
    const before = await ui.eval(`
      const host = document.querySelector('[data-test="dashboard-browser-host"]');
      const webview = document.querySelector('.dashboard-browser-webview.active');
      const button = document.querySelector('[data-test="workspace-tab-customer-service"]');
      return {
        customerWebviewCount: document.querySelectorAll('.customer-service-webview').length,
        host: host ? { className: host.className, opacity: getComputedStyle(host).opacity, pointerEvents: getComputedStyle(host).pointerEvents, rect: host.getBoundingClientRect().toJSON() } : null,
        webview: webview ? { className: webview.className, opacity: getComputedStyle(webview).opacity, pointerEvents: getComputedStyle(webview).pointerEvents, rect: webview.getBoundingClientRect().toJSON() } : null,
        button: button ? button.getBoundingClientRect().toJSON() : null,
        topAtButton: button ? (() => { const r = button.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { tag: top?.tagName, test: top?.getAttribute('data-test'), text: top?.textContent?.trim() } })() : null
      };
    `)
    const customerButtonPoint = await clickAt(ui, '[data-test="workspace-tab-customer-service"]')
    await waitFor(ui, `return document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden') === false`, 5000)
    const service = await ui.eval(`
      const service = document.querySelector('[data-test="customer-service-workspace"]');
      const back = document.querySelector('[data-test="customer-service-back-commerce"]');
      const host = document.querySelector('[data-test="dashboard-browser-host"]');
      const webview = document.querySelector('.dashboard-browser-webview.active');
      const hit = back ? (() => { const r = back.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { tag: top?.tagName, test: top?.getAttribute('data-test'), text: top?.textContent?.trim() } })() : null;
      return {
        serviceClass: service?.className,
        serviceRect: service?.getBoundingClientRect().toJSON(),
        backRect: back?.getBoundingClientRect().toJSON(),
        backHit: hit,
        host: host ? { className: host.className, opacity: getComputedStyle(host).opacity, pointerEvents: getComputedStyle(host).pointerEvents, rect: host.getBoundingClientRect().toJSON() } : null,
        webview: webview ? { className: webview.className, opacity: getComputedStyle(webview).opacity, pointerEvents: getComputedStyle(webview).pointerEvents, rect: webview.getBoundingClientRect().toJSON() } : null
      };
    `)
    const backPoint = await clickAt(ui, '[data-test="customer-service-back-commerce"]')
    await waitFor(ui, `return document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden') === true`, 5000)
    const after = await ui.eval(`
      const host = document.querySelector('[data-test="dashboard-browser-host"]');
      const webview = document.querySelector('.dashboard-browser-webview.active');
      return { serviceHidden: document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden'), host: host?.className, webview: webview?.className, webviewCount: document.querySelectorAll('.dashboard-browser-webview').length };
    `)
    console.log(JSON.stringify({ siteUrl, created, before, customerButtonPoint, service, backPoint, after }, null, 2))
    if (service.backHit?.test !== 'customer-service-back-commerce') throw new Error('customer-service back button is not the top hit target')
    if (before.customerWebviewCount !== 0) throw new Error('customer-service webview was created before opening the workspace')
    if (!service.host?.className.includes('dashboard-browser-host') || service.host.className.includes(' active')) throw new Error('browser host remained active while customer service was open')
    if (!after.serviceHidden || !after.host.includes(' active') || !after.webview?.includes('active')) throw new Error('workbench was not restored after return')
    console.log('CUSTOMER_SERVICE_SWITCH_LOCAL_ALL_PASSED')
  } finally {
    if (ui) ui.close()
    if (app) killTree(app)
    await new Promise(resolve => site.close(() => resolve()))
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
}

main().catch(error => { console.error('CUSTOMER_SERVICE_SWITCH_LOCAL_FAILED', error.stack || error); process.exitCode = 1 })
