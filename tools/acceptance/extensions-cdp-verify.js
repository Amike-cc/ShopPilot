/**
 * 浏览器扩展（本地解包）端到端验收 —— 2026-10-17
 *
 * 前置：临时 userData 里预置两个扩展目录（扩展管理器的管理目录）：
 *   ext_fix00001  合法 fixture（content script 给页面打 data-shopilot-fixture）
 *   ext_bad00001  非法清单（申请 nativeMessaging）→ 必须显示 invalid，且不加载
 *
 * 覆盖：
 *   1) 总开关关闭时扩展不加载；列表能识别合法/非法清单
 *   2) 开启 + 启用后，店铺页面出现 fixture 标记
 *   3) 加载扩展后指纹档案仍 verified（UA/语言/时区/屏幕）
 *   4) 停用 → 已开页面重载 → 标记消失；重新启用 → 恢复
 *   5) 总开关关闭 → 所有已加载扩展卸载、标记消失
 *   6) 非法扩展删除 → 管理目录被清理、列表回到 1 条
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { resolveApp, appArgs } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_EXTENSION_CDP_PORT || 9370)
const SITE = Number(process.env.SHOPILOT_EXTENSION_SITE_PORT || 9371)
const sleep = ms => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const pending = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
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

async function findStorePage(timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const list = await targets().catch(() => [])
    const target = list.find(item => item.webSocketDebuggerUrl && item.url.includes(`127.0.0.1:${SITE}`))
    if (target) {
      const page = new CDP(target.webSocketDebuggerUrl)
      await page.ready
      return page
    }
    await sleep(500)
  }
  return null
}

function copyFileTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source)) {
    const src = path.join(source, name)
    if (fs.statSync(src).isDirectory()) copyFileTree(src, path.join(target, name))
    else fs.copyFileSync(src, path.join(target, name))
  }
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-extensions-' + Date.now())
  const extRoot = path.join(userData, 'extensions')
  fs.mkdirSync(extRoot, { recursive: true })
  copyFileTree(path.join(ROOT, 'tests/fixtures/extensions/dom-marker'), path.join(extRoot, 'ext_fix00001'))
  fs.mkdirSync(path.join(extRoot, 'ext_bad00001'), { recursive: true })
  fs.writeFileSync(path.join(extRoot, 'ext_bad00001', 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Bad Fixture',
    version: '1.0.0',
    permissions: ['nativeMessaging']
  }))

  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><h1>extension fixture</h1></body></html>')
  })
  await new Promise(resolve => site.listen(SITE, '127.0.0.1', resolve))

  const appInfo = resolveApp(ROOT)
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1'
    }
  })
  let appLog = ''
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })

  let ui = null
  let page = null
  try {
    for (let i = 0; i < 120; i++) {
      try {
        const list = await targets()
        const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
        if (target) { ui = new CDP(target.webSocketDebuggerUrl); await ui.ready; break }
      } catch { /* retry */ }
      await sleep(500)
    }
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(800)

    const list0 = await ui.eval(`return await window.shopilot.extensions.list()`)
    const items0 = list0.ok ? list0.data.items : []
    const good0 = items0.find(item => item.id === 'ext_fix00001')
    const bad0 = items0.find(item => item.id === 'ext_bad00001')
    check('列表识别合法/非法扩展（默认总开关关闭）',
      list0.ok === true && list0.data.master === false && !!good0 && good0.status === 'disabled' &&
        !!bad0 && bad0.status === 'invalid' && /nativeMessaging/.test(bad0.loadError || ''),
      JSON.stringify({ master: list0.data?.master, good: good0?.status, bad: bad0?.status, badError: bad0?.loadError }))

    const master = await ui.eval(`return await window.shopilot.extensions.setMaster(true)`)
    check('开启总开关', master.ok === true && master.data.master === true)
    const enabled = await ui.eval(`return await window.shopilot.extensions.setEnabled('ext_fix00001', true)`)
    const goodEnabled = enabled.ok ? enabled.data.items.find(item => item.id === 'ext_fix00001') : null
    check('启用合法扩展（状态 enabled，非法扩展仍 invalid）',
      enabled.ok === true && goodEnabled?.enabled === true && goodEnabled?.status === 'enabled' &&
        enabled.data.items.find(item => item.id === 'ext_bad00001')?.status === 'invalid',
      JSON.stringify({ good: goodEnabled?.status, bad: enabled.data?.items?.find(i => i.id === 'ext_bad00001')?.status }))

    const store = await ui.eval(`return await window.shopilot.store.create({ name: '扩展验收店', platform: '抖店', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!store.ok) throw new Error('创建店铺失败：' + JSON.stringify(store.error))
    const storeId = store.data.id
    const opened = await ui.eval(`return await window.shopilot.browser.open(${JSON.stringify(storeId)})`)
    check('打开店铺浏览器', opened.ok === true)

    page = await findStorePage()
    if (!page) throw new Error('店铺页面 target 未就绪')
    await sleep(1200)
    const markerOn = await page.eval(`return { marker: document.documentElement.getAttribute('data-shopilot-fixture'), url: location.href }`)
    check('扩展 content script 已注入（页面出现标记）', markerOn.marker === '1', JSON.stringify(markerOn))

    const verify = await ui.eval(`return await window.shopilot.profile.verify(${JSON.stringify(storeId)})`)
    const verifiedFields = verify.ok
      ? (verify.data.items || []).filter(item => ['userAgent', 'language', 'timezone', 'screen'].includes(item.field))
      : []
    check('加载扩展后指纹档案仍为 verified（UA/语言/时区/屏幕）',
      verifiedFields.length === 4 && verifiedFields.every(item => item.state === 'verified'),
      JSON.stringify(verifiedFields.map(item => item.field + ':' + item.state)))

    await ui.eval(`return await window.shopilot.extensions.setEnabled('ext_fix00001', false)`)
    await sleep(2500)
    page.close()
    page = await findStorePage()
    const markerOff = page ? await page.eval(`return document.documentElement.getAttribute('data-shopilot-fixture')`) : 'no-target'
    check('停用扩展 → 已开页面重载 → 标记消失', markerOff === null, String(markerOff))

    await ui.eval(`return await window.shopilot.extensions.setEnabled('ext_fix00001', true)`)
    await sleep(2500)
    page.close()
    page = await findStorePage()
    const markerBack = page ? await page.eval(`return document.documentElement.getAttribute('data-shopilot-fixture')`) : 'no-target'
    check('重新启用 → 标记恢复', markerBack === '1', String(markerBack))

    const masterOff = await ui.eval(`return await window.shopilot.extensions.setMaster(false)`)
    await sleep(2500)
    page.close()
    page = await findStorePage()
    const markerAfterMaster = page ? await page.eval(`return document.documentElement.getAttribute('data-shopilot-fixture')`) : 'no-target'
    check('关闭总开关 → 已加载扩展卸载、标记消失', masterOff.ok === true && markerAfterMaster === null, String(markerAfterMaster))

    const removed = await ui.eval(`return await window.shopilot.extensions.remove('ext_bad00001')`)
    const badDirGone = !fs.existsSync(path.join(extRoot, 'ext_bad00001'))
    check('删除非法扩展 → 目录清理、列表只剩合法项',
      removed.ok === true && removed.data.items.length === 1 && badDirGone,
      JSON.stringify({ count: removed.data?.items?.length, badDirGone }))

    // 自己写插件的工作流：必须能打开应用内副本目录（改完点「重载」才生效）。
    // 这里不断言真的弹出资源管理器（会干扰后续步骤），只验证路径边界与入口存在。
    const openBad = await ui.eval(`return await window.shopilot.extensions.openDir('ext_zzzzzzzz')`)
    check('打开不存在的扩展目录 → 如实报 EXTENSION_NOT_FOUND（不暴露路径）',
      openBad.ok === false && openBad.error?.code === 'EXTENSION_NOT_FOUND' && !/[A-Za-z]:\\\\/.test(JSON.stringify(openBad)),
      JSON.stringify(openBad.error))

    const settingsUi = await ui.eval(`
      document.querySelector('[data-test="settings-open-btn"]')?.click()
      await new Promise(r => setTimeout(r, 500))
      document.querySelector('[data-test="settings-tab-extensions"]')?.click()
      await new Promise(r => setTimeout(r, 500))
      return {
        pane: !!document.querySelector('[data-test="settings-extensions"]'),
        openRoot: !!document.querySelector('[data-test="extensions-open-root"]'),
        openRow: !!document.querySelector('[data-test="extensions-open-dir"]')
      }
    `)
    check('扩展页签提供「打开扩展目录」入口（根目录 + 单个扩展）',
      settingsUi.pane === true && settingsUi.openRoot === true && settingsUi.openRow === true,
      JSON.stringify(settingsUi))
  } finally {
    try { page?.close() } catch { /* ignore */ }
    try { ui?.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(1000)
    try { require('child_process').execSync('taskkill /IM ShopPilot.exe /T /F', { stdio: 'ignore' }) } catch { /* ignore */ }
    site.close()
  }

  const passed = checks.filter(item => item.pass).length
  console.log(`\n浏览器扩展验收：${passed}/${checks.length} 通过`)
  if (passed !== checks.length) {
    console.log('失败项：')
    for (const item of checks.filter(entry => !entry.pass)) console.log(`  - ${item.name} :: ${item.detail}`)
    console.log('--- 应用日志（扩展相关）---')
    console.log(appLog.split('\n').filter(line => /extension|扩展/i.test(line)).slice(-20).join('\n'))
    process.exit(1)
  }
}

main().catch(error => { console.error('EXTENSION_VERIFY_CRASH', error); process.exit(2) })
