/**
 * Local end-to-end check for vertical store-list drag sorting.
 * Uses an isolated temporary userData directory so real store order is untouched.
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_STORE_DRAG_CDP_PORT || '9262'
const results = []

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* process already exited */ }
}

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  } catch { /* port is free */ }
}

function focusAppWindow(pid) {
  if (process.platform !== 'win32' || !pid) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 20; $i++) { if ($w.AppActivate(${pid})) { break }; Start-Sleep -Milliseconds 300 }"`,
      { stdio: 'ignore', timeout: 20000 }
    )
  } catch { /* synthetic DOM events do not depend on focus */ }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression, awaitPromise = true) {
    await this.ready
    const result = await this.send('Runtime.evaluate', {
      expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
      awaitPromise,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function waitForCDP(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`
    const until = Date.now() + 15000
    while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    return !!window.shopilot
  `)
  return cdp
}

async function waitForCards(ui, expectedNames, timeoutMs = 10000) {
  const started = Date.now()
  let last = []
  while (Date.now() - started < timeoutMs) {
    last = await ui.eval(`
      return [...document.querySelectorAll('[data-test="store-card"] .store-name')].map(el => el.textContent || '')
    `)
    if (JSON.stringify(last) === JSON.stringify(expectedNames)) return last
    await sleep(200)
  }
  return last
}

async function main() {
  console.log('=== 店铺上下拖动本地端到端验收 ===')
  const userData = path.join(os.tmpdir(), 'shopilot-store-drag-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)

  let app = null
  let ui = null
  try {
    app = spawn(electronExe, [
      root,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    focusAppWindow(app.pid)
    await sleep(1000)
    ui = await connectUi()

    const names = ['拖动验收-A', '拖动验收-B', '拖动验收-C']
    const created = []
    for (const name of names) {
      const res = await ui.eval(`return await window.shopilot.store.create(${JSON.stringify({ name, platform: '拼多多' })})`)
      check(`创建验收店铺 ${name}`, res.ok && !!res.data?.id, JSON.stringify(res.error || res.data))
      if (res.ok) created.push(res.data.id)
    }
    if (created.length !== 3) throw new Error('failed to create three stores')

    const baseline = await ui.eval(`return await window.shopilot.store.reorder(${JSON.stringify(created)})`)
    check('建立已知初始顺序 A/B/C', baseline.ok, JSON.stringify(baseline.error || baseline.data))

    await ui.eval('location.reload(); return true;')
    await sleep(2800)
    const initialDom = await waitForCards(ui, names)
    check('页面按初始顺序显示 A/B/C', JSON.stringify(initialDom) === JSON.stringify(names), JSON.stringify(initialDom))

    const dragState = await ui.eval(`
      const cards = [...document.querySelectorAll('[data-test="store-card"]')]
      if (cards.length !== 3) return { error: 'expected 3 cards, got ' + cards.length }
      const source = cards[2]
      const target = cards[0]
      const transfer = new DataTransfer()
      const sourceRect = source.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: sourceRect.left + 10, clientY: sourceRect.top + sourceRect.height / 2
      }))
      await new Promise(requestAnimationFrame)
      const draggingClass = source.classList.contains('dragging')
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: targetRect.left + 10, clientY: targetRect.top + 1
      }))
      await new Promise(requestAnimationFrame)
      const insertIndicator = target.classList.contains('drag-over-before')
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: targetRect.left + 10, clientY: targetRect.top + 1
      }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
      return { draggingClass, insertIndicator }
    `)
    check('拖动源有 dragging 状态', dragState.draggingClass, JSON.stringify(dragState))
    check('目标上方显示插入线', dragState.insertIndicator, JSON.stringify(dragState))

    await sleep(800)
    const expectedAfterDrag = ['拖动验收-C', '拖动验收-A', '拖动验收-B']
    const apiAfterDrag = await ui.eval(`
      const res = await window.shopilot.store.list()
      return {
        ok: res.ok,
        names: (res.data || []).map(s => s.name),
        sortOrders: (res.data || []).map(s => s.sortOrder)
      }
    `)
    check('拖动 C 到 A 上方后数据库顺序为 C/A/B',
      apiAfterDrag.ok && JSON.stringify(apiAfterDrag.names) === JSON.stringify(expectedAfterDrag),
      JSON.stringify(apiAfterDrag))
    check('数据库 sortOrder 重排为 0/1/2',
      JSON.stringify(apiAfterDrag.sortOrders) === JSON.stringify([0, 1, 2]),
      JSON.stringify(apiAfterDrag.sortOrders))

    await ui.eval('location.reload(); return true;')
    await sleep(2800)
    const afterReload = await waitForCards(ui, expectedAfterDrag)
    check('刷新页面后仍保持 C/A/B',
      JSON.stringify(afterReload) === JSON.stringify(expectedAfterDrag),
      JSON.stringify(afterReload))
  } finally {
    ui?.close()
    killTree(app)
    try {
      const resolvedTemp = path.resolve(os.tmpdir())
      const resolvedUserData = path.resolve(userData)
      if (resolvedUserData.startsWith(resolvedTemp + path.sep)) {
        fs.rmSync(resolvedUserData, { recursive: true, force: true })
      }
    } catch { /* test cleanup only */ }
  }

  const passed = results.filter(item => item.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed !== results.length) process.exit(1)
}

main().catch(err => {
  console.error(err.stack || err)
  process.exit(1)
})
