/**
 * 底座工具验收：页面内查找 / 缩放 / 下载控制（2026-11-08）
 *
 * 为什么单独一条：这三项都是**交互行为**，单测只能证明纯函数算得对，
 * 证明不了「按下 Ctrl+F 真的出查找条」「暂停后再点继续真的还能跑」。
 *
 * 覆盖：
 *   1) 渲染层路径：Ctrl+F 打开查找条、输入即查、命中计数 1/3、下一个 → 2/3、Esc 关闭
 *   2) **真实用户路径**：CDP 向 guest <webview> 注入 Ctrl+F，经主进程 before-input-event
 *      转发后仍能打开查找条（props.active 守卫若挪错位置，本节会红）
 *   3) 缩放：按钮 + 快捷键各调一档、换 origin 导航后仍然套用（证明 dom-ready 重套生效，
 *      而不是靠 Chromium 自己的按 origin 记忆）、百分比点击复位、localStorage 按店持久化
 *   4) 下载：真实 HTTP 慢速下载 → 暂停（DB=已暂停）→ 继续 → 取消（DB=cancelled），
 *      以及未知 id 如实回 not-active、终态行不再显示控制按钮
 *
 * 前置：`node tools/acceptance/build-acceptance.mjs --dir` 产出的 release/win-unpacked
 *（或 SHOPILOT_ACCEPTANCE_SOURCE=1 走源码 Electron + 已 build 的 out/）。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { CdpClient, waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_BROWSER_TOOLS_CDP_PORT || 9394)
const SITE = Number(process.env.SHOPILOT_BROWSER_TOOLS_SITE_PORT || 9395)
const STORE_NAME = '底座工具验收'
const DOWNLOAD_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const CHUNK_INTERVAL_MS = 120

const json = value => JSON.stringify(value)
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head>
<body><h1>alpha beta alpha gamma</h1><p>alpha 用于页面内查找的命中计数。</p></body></html>`

/** 慢速下载夹具：8MB / 64KB 每 120ms ≈ 15s，足够暂停-继续-取消。 */
function createFixture() {
  return http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0]
    if (pathname === '/slow') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': DOWNLOAD_BYTES,
        'Content-Disposition': 'attachment; filename="slow-fixture.bin"'
      })
      let sent = 0
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(timer); return }
        if (sent >= DOWNLOAD_BYTES) { clearInterval(timer); res.end(); return }
        res.write(Buffer.alloc(CHUNK_BYTES, 0x61))
        sent += CHUNK_BYTES
      }, CHUNK_INTERVAL_MS)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
  })
}

async function main() {
  const userData = process.env.SHOPILOT_BROWSER_TOOLS_USER_DATA || path.join(os.tmpdir(), 'shopilot-browser-tools-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  const acceptanceLog = path.join(userData, 'acceptance-app.log')

  const site = createFixture()
  // 不指定 host：127.0.0.1 与 localhost 都能访问，用来验证「换 origin 后缩放被重新套用」
  await new Promise(resolve => site.listen(SITE, resolve))

  const appInfo = resolveApp(ROOT)
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production',
      ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1',
      SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  const { check, summary } = createChecker()
  let ui = null
  let guest = null

  try {
    ui = await waitForMainWindow(PORT, { timeoutMs: 90000 })
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(900)

    const waitFor = async (body, { timeoutMs = 15000, intervalMs = 250, label = '' } = {}) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        try { last = await ui.eval(body) } catch { last = null }
        if (last) return last
        await sleep(intervalMs)
      }
      if (label) console.log(`[timeout] ${label} :: ${json(last)}`)
      return null
    }

    // ---------- 准备：店铺 + 走用户路径打开工作区 ----------
    const created = await ui.eval(`return await window.shopilot.store.create({ name: ${json(STORE_NAME)}, platform: '抖店', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!created?.ok) throw new Error('创建店铺失败：' + json(created))
    const storeId = created.data.id

    const activated = await ui.eval(`
      const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(el => (el.textContent || '').includes('店铺管理'))
      if (!nav) return { ok: false, why: 'no-nav' }
      nav.click()
      await new Promise(r => setTimeout(r, 700))
      const card = [...document.querySelectorAll('article.unified-store-card')].find(el => (el.textContent || '').includes(${json(STORE_NAME)}))
      if (!card) return { ok: false, why: 'no-card' }
      const open = [...card.querySelectorAll('button')].find(btn => (btn.textContent || '').includes('打开工作区'))
      if (!open) return { ok: false, why: 'no-open-button' }
      open.click()
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const host = document.querySelector('[data-test="dashboard-browser-host"]')
        if (host && host.classList.contains('active')) return { ok: true }
        await new Promise(r => setTimeout(r, 220))
      }
      return { ok: false, why: 'host-not-active' }
    `)
    check('走用户路径打开工作区（浏览器表面真的激活，页面内快捷键的前置条件）', activated?.ok === true, json(activated))

    const pageReady = await waitFor(`
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      if (!el) return null
      let factor = null
      try { factor = el.getZoomFactor() } catch { factor = null }
      return { url: String(el.getURL() || ''), factor }
    `, { label: 'webview attach' })
    check('店铺页面已挂载为真实 webview', !!pageReady && pageReady.url.includes(`:${SITE}`), json(pageReady))

    // ---------- 1) 查找：渲染层路径 ----------
    const openedByRenderer = await ui.eval(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
      await new Promise(r => setTimeout(r, 320))
      const input = document.querySelector('[data-test="browser-find-input"]')
      return { bar: !!document.querySelector('[data-test="browser-find-bar"]'), focused: document.activeElement === input }
    `)
    check('Ctrl+F 打开查找条并聚焦输入框', openedByRenderer.bar === true && openedByRenderer.focused === true, json(openedByRenderer))

    const typed = await ui.eval(`
      const input = document.querySelector('[data-test="browser-find-input"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'alpha')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const text = document.querySelector('[data-test="browser-find-count"]')?.textContent?.trim() || ''
        if (/^\\d+\\/\\d+$/.test(text) && !text.startsWith('0/')) return { count: text }
        await new Promise(r => setTimeout(r, 150))
      }
      return { count: document.querySelector('[data-test="browser-find-count"]')?.textContent?.trim() || null }
    `)
    check('输入 alpha 后命中计数为 1/3（fixture 里正好三处）', typed?.count === '1/3', json(typed))

    const nextHit = await ui.eval(`
      document.querySelectorAll('[data-test="browser-find-bar"] button')[1].click()
      await new Promise(r => setTimeout(r, 400))
      return { count: document.querySelector('[data-test="browser-find-count"]')?.textContent?.trim() || null }
    `)
    check('点「下一个」跳到 2/3', nextHit?.count === '2/3', json(nextHit))

    const closed = await ui.eval(`
      const input = document.querySelector('[data-test="browser-find-input"]')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      return { bar: !!document.querySelector('[data-test="browser-find-bar"]') }
    `)
    check('Esc 关闭查找条', closed?.bar === false, json(closed))

    // ---------- 2) 查找：真实用户路径（焦点在 guest 里）----------
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const guestTarget = targets.find(item => item.type === 'webview' && String(item.url || '').includes(`:${SITE}`))
    if (!guestTarget) throw new Error('未找到 guest CDP target：' + json(targets.map(item => ({ type: item.type, url: String(item.url || '').slice(0, 60) }))))
    guest = new CdpClient(guestTarget.webSocketDebuggerUrl)
    await guest.ready
    await guest.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
    await guest.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
    await sleep(500)
    const openedByGuest = await ui.eval(`return { bar: !!document.querySelector('[data-test="browser-find-bar"]') }`)
    check('焦点在店铺页面里按 Ctrl+F 也能打开（主进程转发链路）', openedByGuest?.bar === true, json(openedByGuest))

    await ui.eval(`
      const input = document.querySelector('[data-test="browser-find-input"]')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      return true
    `)

    // ---------- 3) 缩放 ----------
    const zoomInitial = await ui.eval(`
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      return {
        factor: (() => { try { return el.getZoomFactor() } catch { return null } })(),
        label: document.querySelector('[data-test="browser-zoom-value"]')?.textContent?.trim() || null
      }
    `)
    check('缩放初始为 100%', Math.abs(Number(zoomInitial.factor) - 1) < 0.001 && zoomInitial.label === '100%', json(zoomInitial))

    const zoomedOnce = await ui.eval(`
      document.querySelector('[aria-label="放大页面"]').click()
      await new Promise(r => setTimeout(r, 350))
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      return {
        factor: (() => { try { return el.getZoomFactor() } catch { return null } })(),
        label: document.querySelector('[data-test="browser-zoom-value"]')?.textContent?.trim() || null
      }
    `)
    check('点「+」放大到 110%', Math.abs(Number(zoomedOnce.factor) - 1.1) < 0.01 && zoomedOnce.label === '110%', json(zoomedOnce))

    // 快捷键：先把焦点交给 guest，再注入 Ctrl+=（主进程转发 → 渲染层再调一档）
    await guest.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187 })
    await guest.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187 })
    await sleep(500)
    const zoomedByKey = await ui.eval(`
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      return {
        factor: (() => { try { return el.getZoomFactor() } catch { return null } })(),
        label: document.querySelector('[data-test="browser-zoom-value"]')?.textContent?.trim() || null,
        saved: window.localStorage.getItem('shopilot:zoom:${storeId}')
      }
    `)
    check('页面内 Ctrl+= 再放大一档到 125%，并按店铺持久化',
      Math.abs(Number(zoomedByKey.factor) - 1.25) < 0.01 && zoomedByKey.label === '125%' && zoomedByKey.saved === '1.25',
      json(zoomedByKey))

    // 换 origin（127.0.0.1 → localhost）再导航：Chromium 的按 origin 缩放会回落，
    // 这里仍然是 125% 才能证明 dom-ready 的「重套」真的生效
    const tabList = await ui.eval(`const s = await window.shopilot.browser.tab.list(${json(storeId)}); return s.ok ? s.data.tabs : []`)
    const tabId = Array.isArray(tabList) && tabList.length ? tabList[0].id : null
    if (!tabId) throw new Error('取当前标签页失败：' + json(tabList))
    const navigated = await ui.eval(`
      const res = await window.shopilot.browser.navigate(${json(storeId)}, ${json(tabId)}, 'http://localhost:${SITE}/?origin=2')
      return { ok: res.ok, error: res.error || null }
    `)
    const afterOrigin = await waitFor(`
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      if (!el) return null
      const url = String(el.getURL() || '')
      if (!url.includes('localhost:${SITE}')) return null
      return { url, factor: (() => { try { return el.getZoomFactor() } catch { return null } })() }
    `, { timeoutMs: 12000, label: 'origin navigation' })
    check('换 origin 导航后仍是 125%（dom-ready 重套生效，而非 Chromium 记忆）',
      navigated.ok === true && !!afterOrigin && Math.abs(Number(afterOrigin.factor) - 1.25) < 0.01,
      json({ navigated, afterOrigin }))

    const reset = await ui.eval(`
      document.querySelector('[data-test="browser-zoom-value"]').click()
      await new Promise(r => setTimeout(r, 350))
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      return {
        factor: (() => { try { return el.getZoomFactor() } catch { return null } })(),
        label: document.querySelector('[data-test="browser-zoom-value"]')?.textContent?.trim() || null
      }
    `)
    check('点百分比复位到 100%', Math.abs(Number(reset.factor) - 1) < 0.001 && reset.label === '100%', json(reset))

    // ---------- 4) 下载控制 ----------
    const triggered = await ui.eval(`
      const el = document.querySelector('webview[data-store-id="${storeId}"]')
      await el.executeJavaScript(\`(() => {
        const a = document.createElement('a')
        a.href = '/slow'
        a.download = 'slow-fixture.bin'
        document.body.appendChild(a)
        a.click()
        a.remove()
        return true
      })()\`)
      return { ok: true }
    `)
    check('在页面里触发一次慢速下载', triggered?.ok === true, json(triggered))

    const progressing = await waitFor(`
      const res = await window.shopilot.download.list(${json(storeId)}, 10)
      if (!res.ok) return null
      const row = res.data.find(item => item.state === 'progressing' || item.state === 'in_progress')
      return row ? { id: row.id, state: row.state } : null
    `, { timeoutMs: 15000, label: 'download start' })
    check('下载进入进行中状态', !!progressing, json(progressing))

    const panel = await ui.eval(`
      document.querySelector('[data-test="rail-downloads"]')?.click()
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        if (document.querySelector('[data-test="download-pause-resume"]')) return { open: true }
        await new Promise(r => setTimeout(r, 200))
      }
      return { open: false }
    `)
    check('下载面板出现「暂停/取消」控制按钮', panel?.open === true, json(panel))

    const paused = await ui.eval(`
      document.querySelector('[data-test="download-pause-resume"]').click()
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        const res = await window.shopilot.download.list(${json(storeId)}, 10)
        const row = res.ok ? res.data[0] : null
        if (row && row.state === 'paused') {
          const label = [...document.querySelectorAll('.browser-panel-row')].map(el => el.textContent || '').join(' ')
          return { state: row.state, text: /已暂停/.test(label) }
        }
        await new Promise(r => setTimeout(r, 200))
      }
      return { state: null }
    `)
    check('暂停后 DB 状态为 paused，行文案为「已暂停」', paused?.state === 'paused' && paused?.text === true, json(paused))

    const resumed = await ui.eval(`
      document.querySelector('[data-test="download-pause-resume"]').click()
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        const res = await window.shopilot.download.list(${json(storeId)}, 10)
        const row = res.ok ? res.data[0] : null
        if (row && row.state !== 'paused') return { state: row.state }
        await new Promise(r => setTimeout(r, 150))
      }
      return { state: null }
    `)
    check('继续后离开 paused（回到进行中）', resumed?.state === 'progressing' || resumed?.state === 'in_progress' || resumed?.state === 'completed', json(resumed))

    const cancelled = await ui.eval(`
      document.querySelector('[data-test="download-cancel"]')?.click()
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        const res = await window.shopilot.download.list(${json(storeId)}, 10)
        const row = res.ok ? res.data[0] : null
        if (row && row.state === 'cancelled') {
          return { state: row.state, controls: document.querySelectorAll('[data-test="download-pause-resume"]').length }
        }
        await new Promise(r => setTimeout(r, 200))
      }
      return { state: null }
    `)
    check('取消后 DB 状态为 cancelled，终态行不再显示控制按钮',
      cancelled?.state === 'cancelled' && cancelled?.controls === 0, json(cancelled))

    const unknown = await ui.eval(`
      const res = await window.shopilot.download.pause('download_not_exists')
      return { ok: res.ok, inner: res.data || null }
    `)
    check('对不存在的下载如实回 not-active（不伪造成功）',
      unknown?.ok === true && unknown?.inner?.result === 'not-active' && unknown?.inner?.ok === false,
      json(unknown))
  } finally {
    try { guest?.close() } catch { /* ignore */ }
    try { ui?.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await sleep(900)
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
      await sleep(400)
    }
    try { fs.writeFileSync(acceptanceLog, appLog, 'utf8') } catch { /* ignore */ }
    try { site.close() } catch { /* ignore */ }
  }

  const ok = summary('底座工具验收')
  if (!ok) {
    console.log('--- 应用日志（error/download/find/zoom）---')
    console.log(appLog.split('\n').filter(line => /error|download|find|zoom|crash/i.test(line)).slice(-25).join('\n'))
    process.exit(1)
  }
}

main().catch(error => { console.error('BROWSER_TOOLS_VERIFY_CRASH', error); process.exit(2) })
