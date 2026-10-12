/*
 * Local desktop probe for per-store customer-service sessions and the workbench boundary.
 * Uses a temporary profile and two disposable local stores; customer pages use the configured
 * platform URLs and no existing browser profile or account credentials.
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electron = process.env.SHOPILOT_CUSTOMER_SERVICE_ELECTRON || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const packaged = /ShopPilot\.exe$/i.test(electron)
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
    const args = packaged
      ? ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
      : [root, '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows']
    app = spawn(electron, args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })
    await waitForCdp()
    ui = await connectUi()
    const created = await ui.eval(`
      const results = await Promise.all([
        window.shopilot.store.create({ name: '客服切换探针抖店', platform: '抖店', adminUrl: ${JSON.stringify(siteUrl)} }),
        window.shopilot.store.create({ name: '客服切换探针拼多多', platform: '拼多多', adminUrl: ${JSON.stringify(siteUrl)} })
      ]);
      return results.every(result => result.ok) ? results.map(result => result.data.id) : null;
    `)
    if (!Array.isArray(created) || created.length !== 2 || created.some(id => !id)) throw new Error('two disposable store.create calls failed')
    const [storeA, storeB] = created
    try { await ui.eval('location.reload()', false) } catch {}
    await sleep(2500)
    ui.close()
    ui = await connectUi()
    await waitFor(ui, `return document.querySelectorAll('[data-test="store-card"]').length === 2`)
    await clickAt(ui, `[data-test="store-card"][data-store-id="${storeA}"] .store-action`)
    await waitFor(ui, `return document.querySelector('.dashboard-browser-webview.active')?.getAttribute('data-store-id') === ${JSON.stringify(storeA)}`, 12000)
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
    await clickAt(ui, `.customer-service-store[data-store-id="${storeA}"]`)
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
        activeStoreId: document.querySelector('.customer-service-webview')?.getAttribute('data-store-id'),
        activePartition: document.querySelector('.customer-service-webview')?.getAttribute('partition'),
        customerWebviewCount: document.querySelectorAll('.customer-service-webview').length,
        serviceUrl: document.querySelector('.url-value')?.textContent?.trim(),
        host: host ? { className: host.className, opacity: getComputedStyle(host).opacity, pointerEvents: getComputedStyle(host).pointerEvents, rect: host.getBoundingClientRect().toJSON() } : null,
        webview: webview ? { className: webview.className, opacity: getComputedStyle(webview).opacity, pointerEvents: getComputedStyle(webview).pointerEvents, rect: webview.getBoundingClientRect().toJSON() } : null
      };
    `)

    const initialStoreState = await waitFor(ui, `
      const el = document.querySelector('.customer-service-webview');
      if (!el || el.getAttribute('data-store-id') !== ${JSON.stringify(storeA)}) return null;
      let url = '';
      try { url = el.getURL(); } catch {}
      return url.startsWith('https://') ? { url, partition: el.getAttribute('partition') } : null;
    `, 20000)
    if (!initialStoreState) {
      const debug = await ui.eval(`
        const el = document.querySelector('.customer-service-webview');
        let guestUrl = '';
        try { guestUrl = el?.getURL() || ''; } catch {}
        return {
          visible: !document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden'),
          storeId: el?.getAttribute('data-store-id'),
          partition: el?.getAttribute('partition'),
          guestUrl,
          displayedUrl: document.querySelector('.url-value')?.textContent?.trim(),
          loadState: document.querySelector('.customer-browser-load-state')?.textContent?.trim(),
          failure: document.querySelector('.customer-browser-load-state')?.className
        };
      `)
      throw new Error(`first customer-service WebView did not navigate to its platform URL: ${JSON.stringify(debug)}`)
    }
    const initialStoreRoute = await waitFor(ui, `
      const el = document.querySelector('.customer-service-webview');
      if (!el || el.getAttribute('data-store-id') !== ${JSON.stringify(storeA)}) return null;
      let guestUrl = '';
      try { guestUrl = el.getURL(); } catch {}
      const displayedUrl = document.querySelector('.url-value')?.textContent?.trim();
      return guestUrl && displayedUrl === guestUrl ? displayedUrl : null;
    `, 8000)
    if (!initialStoreRoute) throw new Error('customer-service route display did not synchronize with its active guest')
    const navigationCheck = await ui.eval(`
      const el = document.querySelector('.customer-service-webview');
      const before = el?.getURL?.() || '';
      const attempted = typeof el?.loadURL === 'function';
      let requestSettled = false;
      try {
        if (attempted) {
          await Promise.race([
            el.loadURL('https://im.jinritemai.com.attacker.invalid/').finally(() => { requestSettled = true }),
            new Promise(resolve => setTimeout(resolve, 1500))
          ]);
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
      return { attempted, before, after: el?.getURL?.() || '', requestSettled };
    `)

    await clickAt(ui, `.customer-service-store[data-store-id="${storeB}"]`)
    const switchedToB = await waitFor(ui, `
      const views = [...document.querySelectorAll('.customer-service-webview')];
      const active = views[0];
      if (views.length !== 1 || active?.getAttribute('data-store-id') !== ${JSON.stringify(storeB)}) return null;
      return { storeId: active.getAttribute('data-store-id'), partition: active.getAttribute('partition'), heading: document.querySelector('.browser-heading h1')?.textContent?.trim() };
    `, 20000)
    if (!switchedToB) throw new Error('switching to the second shop did not mount one isolated customer-service WebView')

    await clickAt(ui, `.customer-service-store[data-store-id="${storeA}"]`)
    const switchedBackToA = await waitFor(ui, `
      const views = [...document.querySelectorAll('.customer-service-webview')];
      const active = views[0];
      if (views.length !== 1 || active?.getAttribute('data-store-id') !== ${JSON.stringify(storeA)}) return null;
      return { storeId: active.getAttribute('data-store-id'), partition: active.getAttribute('partition'), heading: document.querySelector('.browser-heading h1')?.textContent?.trim(), url: document.querySelector('.url-value')?.textContent?.trim() };
    `, 20000)
    if (!switchedBackToA) throw new Error('switching back to the first shop did not restore its customer-service WebView')

    const backPoint = await clickAt(ui, '[data-test="customer-service-back-commerce"]')
    await waitFor(ui, `return document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden') === true`, 5000)
    const after = await ui.eval(`
      const host = document.querySelector('[data-test="dashboard-browser-host"]');
      const webview = document.querySelector('.dashboard-browser-webview.active');
      return { serviceHidden: document.querySelector('[data-test="customer-service-workspace"]')?.classList.contains('workspace-hidden'), host: host?.className, webview: webview?.className, webviewCount: document.querySelectorAll('.dashboard-browser-webview').length };
    `)
    console.log(JSON.stringify({ siteUrl, created, before, customerButtonPoint, service, initialStoreState, navigationCheck, switchedToB, switchedBackToA, backPoint, after }, null, 2))
    if (service.backHit?.test !== 'customer-service-back-commerce') throw new Error('customer-service back button is not the top hit target')
    if (before.customerWebviewCount !== 0) throw new Error('customer-service webview was created before opening the workspace')
    if (!service.host?.className.includes('dashboard-browser-host') || service.host.className.includes(' active')) throw new Error('browser host remained active while customer service was open')
    if (service.activeStoreId !== storeA || service.activePartition !== `persist:customer-service_${storeA}` || service.customerWebviewCount !== 1) throw new Error('the first customer-service page did not use exactly its own persistent partition')
    if (initialStoreState.partition !== `persist:customer-service_${storeA}`) throw new Error('the first customer-service guest partition does not match its shop id')
    if (!navigationCheck.attempted || navigationCheck.before !== navigationCheck.after) throw new Error('the attached customer-service guest navigated outside its platform allowlist')
    if (switchedToB.storeId !== storeB || switchedToB.partition !== `persist:customer-service_${storeB}` || !switchedToB.heading?.includes('客服切换探针拼多多')) throw new Error('the second customer-service page leaked or reused the first shop state')
    if (switchedBackToA.storeId !== storeA || switchedBackToA.partition !== `persist:customer-service_${storeA}` || switchedBackToA.url !== initialStoreRoute) throw new Error('switching back did not restore the first shop route and partition')
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
