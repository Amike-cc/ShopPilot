/**
 * 界面评审用截图器（UI review 工具）
 *
 * 用法：node tools/acceptance/ui-screenshot.js
 * 前置：pnpm build && electron-builder --dir（保证 release/win-unpacked 是最新代码）
 *
 * 目的：把真实界面按 1440×940 逐页截图到 artifacts/ui-redesign/，供设计评审与回归对比。
 * 数据用真实库的**副本**（临时 userData），不动用户原数据。
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { waitForMainWindow, sleep } = require('./cdp-client')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_SHOT_PORT || 9288)
const OUT = path.join(ROOT, 'artifacts', 'ui-redesign')
const REAL_DB = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')

const PAGES = [
  { key: 'overview', label: '经营总览' },
  { key: 'products', label: '商品管理' },
  { key: 'stores', label: '店铺管理' },
  { key: 'analytics', label: '数据分析' },
  { key: 'invoices', label: '发票中心' },
  { key: 'tax', label: '涉税信息' },
  { key: 'apps', label: 'AI 创作' },
  { key: 'image-studio', label: 'AI 生成商品图', via: 'ai-card' },
  { key: 'graphic-sell', label: '图文带货', via: 'ai-card' },
  { key: 'app-center', label: '应用商城' },
  { key: 'settings', label: '设置中心', via: 'data-test' }
]

function copyDb(userData) {
  fs.mkdirSync(userData, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const from = REAL_DB + suffix
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, 'shopilot.db' + suffix))
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppilot-shot-'))
  copyDb(userData)
  const app = resolveApp(ROOT)
  console.log('[shot] executable =', app.executable, '| packaged =', app.packaged)

  const child = spawn(app.executable, appArgs(ROOT, app, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1' })
  })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  let client = null
  try {
    client = await waitForMainWindow(PORT, { timeoutMs: 90000 })
    if (!client) throw new Error('主窗口未就绪\n' + log.slice(-2000))
    await client.send('Page.enable', {})
    // 用真实窗口尺寸截图（Emulation 覆盖在 Electron 上不改变窗口，截出来仍是原尺寸）
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      const browserClient = new (require('./cdp-client').CdpClient)(version.webSocketDebuggerUrl)
      await browserClient.ready
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const main = list.find(t => t.type === 'page' && String(t.url).includes('index.html'))
      const { windowId } = await browserClient.send('Browser.getWindowForTarget', { targetId: main.id })
      await browserClient.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await browserClient.send('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 940 } })
      console.log('[shot] 窗口调整为 1440×940')
      browserClient.close()
    } catch (err) {
      console.log('[shot] Browser 域不可用，改用 window.resizeTo：', err && err.message)
      const size = await client.eval(`
        try { window.resizeTo(1440, 940) } catch (e) { return { error: String(e) } }
        await new Promise(r => setTimeout(r, 400))
        return { inner: [window.innerWidth, window.innerHeight], outer: [window.outerWidth, window.outerHeight] }
      `)
      console.log('[shot] 调整后尺寸 =', JSON.stringify(size))
    }
    await sleep(1200)

    // 截图用的临时库副本：把可选模块全部启用，保证发票/涉税页面也能进入评审（不触碰真实库）。
    try {
      await client.eval(`await window.shopilot.settings.set('ui.apps.installedModules', ['products','invoices','tax','ai']); return true`)
      await client.send('Page.reload', { ignoreCache: true })
      await sleep(2200)
    } catch (err) {
      console.log('[shot] 启用可选模块失败（继续按当前安装状态截图）：', err && err.message)
    }

    for (const page of PAGES) {
      const clicked = await client.eval(`
        const label = ${JSON.stringify(page.label)}
        if (${JSON.stringify(page.via || '')} === 'data-test') {
          const btn = document.querySelector('[data-test="settings-open-btn"]')
          if (!btn) return false
          btn.click(); return true
        }
        if (${JSON.stringify(page.via || '')} === 'ai-card') {
          const nav = [...document.querySelectorAll('.dashboard-nav-item')]
            .find(el => (el.textContent || '').trim().includes('AI 创作'))
          if (!nav) return false
          nav.click()
          await new Promise(r => setTimeout(r, 700))
          const card = [...document.querySelectorAll('.app-card')]
            .find(el => (el.textContent || '').includes(label))
          if (!card) return false
          card.click(); return true
        }
        const item = [...document.querySelectorAll('.dashboard-nav-item')]
          .find(el => (el.textContent || '').trim().includes(label))
        if (!item) return false
        item.click(); return true
      `)
      await sleep(page.key === 'invoices' ? 1600 : 900)
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const file = path.join(OUT, `${page.key}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log(`[shot] ${page.key.padEnd(11)} clicked=${clicked} → ${path.basename(file)}`)
    }

    // 电商客服工作区（同窗切换，不是新窗口）
    const cs = await client.eval(`
      const btn = document.querySelector('[data-test="workspace-tab-customer-service"]')
      if (!btn) return false
      btn.click(); return true
    `)
    await sleep(2600)
    const csShot = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'customer-service.png'), Buffer.from(csShot.data, 'base64'))
    console.log('[shot] customer-service clicked=' + cs + ' → customer-service.png')
    await client.eval(`
      const back = document.querySelector('[data-test="customer-service-back-commerce"]')
        || [...document.querySelectorAll('[data-test="workspace-tab-workbench"]')].find(el => el.offsetParent !== null)
      back?.click(); return true
    `)
    await sleep(900)

    // 店铺浏览器（guest 宿主 + 标签栏 + 地址栏 + 右侧面板），最容易因外壳改动回归的一面
    const opened = await client.eval(`
      const card = document.querySelector('[data-test="store-card"]')
      if (!card) return false
      card.querySelector('.store-action')?.click() ?? card.click()
      return true
    `)
    await sleep(3200)
    const browserShot = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'browser.png'), Buffer.from(browserShot.data, 'base64'))
    console.log('[shot] browser     clicked=' + opened + ' → browser.png')
    await client.eval(`
      const item = [...document.querySelectorAll('.dashboard-nav-item')]
        .find(el => (el.textContent || '').trim().includes('经营总览'))
      item?.click(); return true
    `)
    await sleep(800)

    // 命令面板
    await client.eval(`document.querySelector('[data-test="command-open"]')?.click(); return true`)
    await sleep(500)
    const cmd = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'command-palette.png'), Buffer.from(cmd.data, 'base64'))
    await client.eval(`document.querySelector('.command-backdrop')?.click(); return true`)
    await sleep(300)

    // 店铺右键菜单
    await client.eval(`
      const card = document.querySelector('[data-test="store-card"]')
      if (!card) return false
      const rect = card.getBoundingClientRect()
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: rect.right - 20, clientY: rect.top + 12
      }))
      return true
    `)
    await sleep(400)
    const ctx = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'store-context-menu.png'), Buffer.from(ctx.data, 'base64'))

    // 添加店铺对话框
    await client.eval(`
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      document.querySelector('[data-test="rail-new"], .sb-add')?.click()
      return true
    `)
    await sleep(500)
    const dlg = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'store-create-dialog.png'), Buffer.from(dlg.data, 'base64'))
    await client.eval(`document.querySelector('[data-test="store-create-dialog"]')?.click(); return true`)
    await sleep(300)

    // 收起态左栏
    await client.eval(`document.querySelector('[data-test="sidebar-collapse"]')?.click(); return true`)
    await sleep(600)
    const rail = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'sidebar-collapsed.png'), Buffer.from(rail.data, 'base64'))
    console.log('[shot] sidebar-collapsed 完成')
  } finally {
    try { client && client.close() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
  }
}

main().then(() => {
  console.log('[shot] 全部完成 →', OUT)
  process.exit(0)
}).catch(err => {
  console.error('[shot] 失败：', err && err.message ? err.message : err)
  process.exit(1)
})
