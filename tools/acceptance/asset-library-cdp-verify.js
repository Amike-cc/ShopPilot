/**
 * 素材库真机验收（2026-11-15）
 *
 * 覆盖：侧栏入口 → 通过文件输入导入两张图 → 缩略图/计数 → 搜索筛选 →
 * 详情改名/打标签 → 作为对话生图参考图 → 删除 → AI 生成来源入库 → 重启后仍在。
 * 直接跑真实渲染层 → preload → 主进程 → SQLite/文件，不 mock 素材库本身。
 *
 * 前置：pnpm build（source 模式）或 release/win-unpacked。
 * 端口：9416（SHOPILOT_ASSETS_CDP_PORT 可覆盖）。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_ASSETS_CDP_PORT || 9416)
const FIXTURES = [
  { file: 'tools/acceptance/fixtures/product-sample.jpg', name: '商品主图.jpg', type: 'image/jpeg' },
  { file: 'apps/desktop/src/renderer/src/assets/ui/graphic-sell/effect-bed-pink-teddy.jpg', name: '粉色床品.jpg', type: 'image/jpeg' }
].map(item => ({ ...item, data: fs.readFileSync(path.join(ROOT, item.file)).toString('base64') }))

async function main() {
  const userData = process.env.SHOPILOT_ASSETS_USER_DATA || path.join(os.tmpdir(), 'shopilot-assets-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })

  const appInfo = resolveApp(ROOT)
  const logPath = process.env.SHOPILOT_ASSETS_LOG || path.join(userData, 'acceptance-app.log')
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  child.on('exit', code => { appLog += `\n[app exit ${code}]\n` })
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })

  const { check, summary } = createChecker()
  let ui = null
  try {
    ui = await waitForMainWindow(PORT)
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(900)

    const navTo = label => ui.eval(`
      const item = [...document.querySelectorAll('.dashboard-nav-item')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
      if (!item) return false
      item.click()
      await new Promise(r => setTimeout(r, 500))
      return true
    `)
    check('侧栏可以进入「素材库」', await navTo('素材库'))
    check('素材库空状态可见', await ui.eval(`return !!document.querySelector('[data-test="asset-library-empty"]')`))

    const injected = await ui.eval(`
      const files = ${JSON.stringify(FIXTURES)}
      const dt = new DataTransfer()
      for (const item of files) {
        const binary = atob(item.data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        dt.items.add(new File([bytes], item.name, { type: item.type }))
      }
      const input = document.querySelector('[data-test="asset-library-file-input"]')
      if (!input) return { input: false }
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { input: true, files: dt.files.length }
    `)
    check('文件输入接收两张图片', injected.input === true && injected.files === 2, JSON.stringify(injected))

    let imported = null
    for (let i = 0; i < 40; i++) {
      imported = await ui.eval(`
        const list = await window.shopilot.assets.list()
        return {
          cards: document.querySelectorAll('[data-test^="asset-library-item-"]').length,
          count: document.querySelector('[data-test="asset-library-count"]')?.textContent?.trim() || '',
          notice: document.querySelector('[data-test="asset-library-notice"]')?.textContent?.trim() || '',
          items: list.ok ? list.data.items.map(item => ({ name: item.name, size: item.size, thumb: item.thumbUrl.slice(0, 24) })) : []
        }
      `)
      if (imported.cards === 2) break
      await sleep(250)
    }
    check('两张图导入并出现在列表', imported.cards === 2 && imported.items.length === 2 && /已导入 2 张/.test(imported.notice), JSON.stringify({ ...imported, items: imported.items }))
    check('列表缩略图由主进程生成（data URL）', imported.items.every(item => item.thumb.startsWith('data:image/jpeg;base64,')), JSON.stringify(imported.items.map(i => i.thumb)))

    const thumbs = await ui.eval(`return [...document.querySelectorAll('.al-thumb img')].map(img => ({ complete: img.complete, width: img.naturalWidth }))`)
    check('缩略图在页面里真实解码（不是空占位）', thumbs.length === 2 && thumbs.every(item => item.complete && item.width > 0), JSON.stringify(thumbs))

    const search = await ui.eval(`
      const input = document.querySelector('[data-test="asset-library-search"]')
      input.value = '粉色'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      return { cards: document.querySelectorAll('[data-test^="asset-library-item-"]').length, text: document.querySelector('[data-test="asset-library-page"]')?.textContent || '' }
    `)
    check('按名称搜索只剩一张', search.cards === 1 && search.text.includes('1 张符合条件'), JSON.stringify({ cards: search.cards }))
    await ui.eval(`
      const input = document.querySelector('[data-test="asset-library-search"]')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      return true
    `)

    const opened = await ui.eval(`
      const card = [...document.querySelectorAll('[data-test^="asset-library-item-"]')].find(el => el.textContent.includes('粉色'))
      if (!card) return { card: false }
      card.click()
      await new Promise(r => setTimeout(r, 700))
      return {
        card: true,
        open: !!document.querySelector('[data-test="asset-library-detail"]'),
        name: document.querySelector('[data-test="asset-detail-name"]')?.value || '',
        image: !!document.querySelector('.al-preview img')
      }
    `)
    check('打开详情并读到原图', opened.open === true && opened.image === true && opened.name.includes('粉色'), JSON.stringify(opened))

    const saved = await ui.eval(`
      const name = document.querySelector('[data-test="asset-detail-name"]')
      const tags = document.querySelector('[data-test="asset-detail-tags"]')
      name.value = '粉色床品-验收'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      tags.value = '童装，场景, #春季'
      tags.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-test="asset-detail-save"]')?.click()
      await new Promise(r => setTimeout(r, 700))
      const list = await window.shopilot.assets.list()
      const row = list.ok ? list.data.items.find(item => item.name === '粉色床品-验收') : null
      return { row, notice: document.querySelector('[data-test="asset-library-notice"]')?.textContent?.trim() || '' }
    `)
    check('详情改名与标签写进主进程', saved.row && saved.row.tags.join(',') === '童装,场景,春季' && /已保存/.test(saved.notice), JSON.stringify({ tags: saved.row?.tags, notice: saved.notice }))

    const used = await ui.eval(`
      document.querySelector('[data-test="asset-detail-use"]')?.click()
      await new Promise(r => setTimeout(r, 900))
      return {
        chat: !!document.querySelector('[data-test="chat-image-page"]'),
        reference: document.querySelector('[data-test="chat-image-reference"]')?.textContent?.trim() || '',
        img: !!document.querySelector('[data-test="chat-image-reference"] img')
      }
    `)
    check('「用于对话生图」切到生图页并带上下一轮参考图', used.chat === true && used.img === true && used.reference.includes('粉色床品-验收'), JSON.stringify(used))

    await navTo('素材库')
    const removed = await ui.eval(`
      window.confirm = () => true
      const card = [...document.querySelectorAll('[data-test^="asset-library-item-"]')].find(el => el.textContent.includes('商品主图'))
      if (!card) return { card: false }
      card.click()
      await new Promise(r => setTimeout(r, 600))
      document.querySelector('[data-test="asset-detail-delete"]')?.click()
      await new Promise(r => setTimeout(r, 900))
      const list = await window.shopilot.assets.list()
      return {
        card: true,
        count: document.querySelector('[data-test="asset-library-count"]')?.textContent?.trim() || '',
        items: list.ok ? list.data.items.map(item => item.name) : []
      }
    `)
    check('删除素材后列表与主进程都只剩一张', removed.card === true && removed.count.startsWith('1 ') && removed.items.length === 1, JSON.stringify(removed))

    const aiAdded = await ui.eval(`
      const b64 = ${JSON.stringify(FIXTURES[0].data)}
      const result = await window.shopilot.assets.addDataUrl({ dataUrl: 'data:image/jpeg;base64,' + b64, name: 'AI 生成验收图', source: 'chat-image', tags: ['AI生成'] })
      document.querySelector('[data-test="asset-library-refresh"]')?.click()
      await new Promise(r => setTimeout(r, 900))
      const select = document.querySelector('[data-test="asset-library-source"]')
      select.value = 'chat-image'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
      return {
        ok: result.ok,
        duplicate: result.ok ? result.data.duplicate : null,
        cards: document.querySelectorAll('[data-test^="asset-library-item-"]').length,
        badge: document.querySelector('.al-source')?.textContent?.trim() || ''
      }
    `)
    check('AI 生成图片可入库并按来源筛选', aiAdded.ok === true && aiAdded.cards === 1 && aiAdded.badge === 'AI 生成', JSON.stringify(aiAdded))

    await ui.send('Page.reload', {})
    await sleep(2500)
    const afterReload = await waitForMainWindow(PORT)
    if (!afterReload) throw new Error('重载后主窗口未就绪')
    ui.close()
    ui = afterReload
    await navTo('素材库')
    const persisted = await ui.eval(`
      const list = await window.shopilot.assets.list()
      return {
        cards: document.querySelectorAll('[data-test^="asset-library-item-"]').length,
        items: list.ok ? list.data.items.map(item => ({ name: item.name, source: item.source })) : []
      }
    `)
    check('重启渲染进程后素材仍在（SQLite + 文件持久化）', persisted.cards === 2 && persisted.items.length === 2, JSON.stringify(persisted))

  } finally {
    try { ui?.close() } catch { /* 已断开 */ }
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    await sleep(1000)
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
      await sleep(500)
    }
    try { fs.writeFileSync(logPath, appLog, 'utf8') } catch { /* 日志只作证据 */ }
  }

  if (!summary('素材库真机验收')) {
    console.log(`--- 应用日志（素材库/异常）---\n${appLog.split('\n').filter(line => /asset|素材|error|crash/i.test(line)).slice(-30).join('\n')}`)
    process.exit(1)
  }
}

main().catch(error => { console.error('ASSETS_VERIFY_CRASH', error); process.exit(2) })
