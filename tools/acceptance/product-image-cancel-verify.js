/**
 * 商品图片下载器 · 取消保存目录后必须取消下载（CDP）
 *
 * 前置：应用以 --remote-debugging-port=9413 启动，且设置
 *       SHOPILOT_TEST_IMAGE_SAVE_CANCEL=1（模拟用户在文件夹弹窗里点取消，
 *       不弹原生窗口，便于无人值守）。
 *
 * 断言：插件状态变为「已取消下载」，本次批次不产生 downloads 记录、不新增文件。
 *
 * 用法：node tools/acceptance/product-image-cancel-verify.js
 */
const path = require('path')
const Database = require('better-sqlite3')
const { CdpClient, waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const PORT = Number(process.env.SHOPILOT_CDP_PORT || 9413)
const STORE_ID = process.env.SHOPILOT_STORE_ID || 'store_485d9ec1e549231e555cc84bc5c59a81'
const URL =
  process.env.HAOHUO_URL ||
  'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3796513554576834775&origin_type=pc_compass_manage'
const USER_DATA = process.env.SHOPILOT_USER_DATA || process.env.APPDATA + '\\shopilot'
const PLUGIN_KEY = 'product-image-downloader'

const checker = createChecker()

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

async function waitForShopilot(main) {
  for (let i = 0; i < 40; i++) {
    if (await main.eval('return typeof window.shopilot !== "undefined"')) return true
    await sleep(500)
  }
  return false
}

async function installPlugin(main) {
  let result = null
  for (let i = 0; i < 4; i++) {
    result = await main.eval(
      `return await window.shopilot.extensions.installFromCatalog(${JSON.stringify(PLUGIN_KEY)})`
    )
    if (result && result.ok === true) return result
    await sleep(800)
  }
  return result
}

async function findPage(beforeIds) {
  for (let i = 0; i < 50; i++) {
    const list = await listTargets()
    const target = list.find(
      item => !beforeIds.has(item.id) && item.type !== 'worker' && String(item.url).includes('haohuo.jinritemai.com')
    )
    if (target) {
      const page = new CdpClient(target.webSocketDebuggerUrl)
      await page.ready
      const found = await page.eval('return !!document.getElementById("__shopilot_product_image_downloader__")')
      if (found) return page
      page.close()
    }
    await sleep(1000)
  }
  return null
}

async function main() {
  const main = await waitForMainWindow(PORT)
  if (!main) throw new Error('主窗口未出现')
  if (!(await waitForShopilot(main))) throw new Error('window.shopilot 未就绪')

  const catalog = await main.eval('return await window.shopilot.extensions.catalog()')
  const entry = ((catalog && catalog.data && catalog.data.entries) || []).find(item => item.key === PLUGIN_KEY)
  checker.check('插件目录里存在 product-image-downloader', !!entry, entry ? `v${entry.version}` : '目录缺失')
  if (!entry) {
    main.close()
    return checker.summary('商品图片下载器 · 取消保存目录验收')
  }
  const installed = await installPlugin(main)
  if (!installed || installed.ok !== true) throw new Error('插件安装失败: ' + JSON.stringify(installed).slice(0, 300))
  const reloaded = await main.eval(`return await window.shopilot.extensions.reload(${JSON.stringify(entry.id)})`)
  checker.check('插件已安装并重载', !!reloaded && reloaded.ok === true, `v${entry.version}`)

  const before = new Set((await listTargets()).map(item => item.id))
  await main.eval(`return await window.shopilot.browser.open(${JSON.stringify(STORE_ID)}, { display: true })`)
  await sleep(600)
  await main.eval(
    `return await window.shopilot.browser.tab.create(${JSON.stringify(STORE_ID)}, ${JSON.stringify(URL)})`
  )
  main.close()

  const page = await findPage(before)
  checker.check('内容脚本注入', !!page)
  if (!page) return checker.summary('商品图片下载器 · 取消保存目录验收')

  await sleep(1500)
  const opened = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    if (!root.querySelector('.panel')) {
      const launcher = root.querySelector('.launcher');
      if (launcher) launcher.click();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { tiles: root.querySelectorAll('.tile').length, selected: root.querySelectorAll('.tile.is-selected').length };
  `)
  checker.check('面板识别并默认全选', opened.tiles > 0 && opened.selected === opened.tiles, `${opened.selected}/${opened.tiles}`)

  const startedAt = Date.now()
  const clicked = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const btn = root.querySelector('[data-act="download"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  `)
  checker.check('点击「下载选中」', clicked)

  let status = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    status = await page.eval(`
      const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
      return (root.querySelector('.status') || {}).textContent.trim();
    `)
    if (/已取消下载|已触发|张失败/.test(status)) break
  }
  checker.check('取消目录后状态为「已取消下载」', /已取消下载/.test(status), status || '超时未更新')

  const busy = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const btn = root.querySelector('[data-act="download"]');
    return { busy: !!root.querySelector('.panel.is-busy'), disabled: !!(btn && btn.disabled) };
  `)
  checker.check('取消后任务结束、按钮恢复可点', !busy.busy && !busy.disabled, JSON.stringify(busy))

  const db = new Database(path.join(USER_DATA, 'shopilot.db'), { readonly: true, fileMustExist: true })
  const rows = db
    .prepare(
      `select file_name, file_path, state from downloads
       where store_id = ? and created_at >= ? and file_name like '2027新年%' order by created_at asc`
    )
    .all(STORE_ID, startedAt - 2000)
  db.close()
  checker.check('取消后不产生下载记录', rows.length === 0, rows.map(row => row.file_name).join(', '))

  page.close()
  const ok = checker.summary('商品图片下载器 · 取消保存目录验收')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('验收异常：', error && error.stack ? error.stack : error)
  process.exit(1)
})
