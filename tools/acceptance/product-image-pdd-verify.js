/**
 * 商品图片下载器 · 拼多多商家后台编辑页真机验收（CDP）
 *
 * 为什么测这个页面：拼多多手机商品页（mobile.yangkeduo.com/goods.html）要求消费者登录，
 * 当前店铺会话没有手机站登录态；商家后台的商品编辑页是同一套商品素材（真实 PDD 图片
 * CDN 与真实 gallery 数据），可以在已登录的商家会话里完整验收下载链路。
 * 手机页的 rawData 解析由 product-image-pdd-mobile-verify.js 用真实图库结构验收。
 *
 * 前置：应用以 --remote-debugging-port=9413 启动，拼多多店铺已登录。
 * 用法：node tools/acceptance/product-image-pdd-verify.js
 */
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const { CdpClient, waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const PORT = Number(process.env.SHOPILOT_CDP_PORT || 9413)
const STORE_ID = process.env.SHOPILOT_STORE_ID || 'store_93b6d25c1d1f47495b632e36200b2034'
const EDIT_URL =
  process.env.PDD_EDIT_URL ||
  'https://mms.pinduoduo.com/goods/goods_add/index?id=205505399494&goods_id=883203414380&type=edit'
const USER_DATA = process.env.SHOPILOT_USER_DATA || process.env.APPDATA + '\\shopilot'
const PLUGIN_KEY = 'product-image-downloader'
const EXPECTED_MAIN = 8
const EXPECTED_DETAIL = 8
const EXPECTED_TOTAL = EXPECTED_MAIN + EXPECTED_DETAIL

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

/** 应用刚启动时扩展文件偶发被占用，install 会失败；重试几次。 */
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
      item => !beforeIds.has(item.id) && item.type !== 'worker' && String(item.url).includes('goods_add')
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

async function domClick(page, selector, label) {
  const clicked = await page.eval(`
    const host = document.getElementById('__shopilot_product_image_downloader__');
    const root = host && host.shadowRoot;
    const el = root && root.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return false;
    el.click();
    return true;
  `)
  checker.check(label, clicked, clicked ? '' : `找不到可点击的 ${selector}`)
  return clicked
}

async function main() {
  const main = await waitForMainWindow(PORT)
  if (!main) throw new Error('主窗口未出现（应用是否带 --remote-debugging-port 启动？）')
  if (!(await waitForShopilot(main))) throw new Error('渲染层 preload 未就绪（window.shopilot 不存在）')

  // 1. 插件目录 / 安装 / 强制重载（开发期改了插件文件必须 reload 才进现有店铺会话）
  const catalog = await main.eval('return await window.shopilot.extensions.catalog()')
  const entries = (catalog && catalog.data && catalog.data.entries) || []
  const entry = entries.find(item => item.key === PLUGIN_KEY)
  checker.check('插件目录里存在 product-image-downloader', !!entry, entry ? `v${entry.version}` : '目录缺失')
  if (!entry) {
    main.close()
    return checker.summary('商品图片下载器 · 拼多多编辑页验收')
  }
  // 每次都重装，确保目录里的新插件文件覆盖 userData 里的旧副本
  const installed = await installPlugin(main)
  if (!installed || installed.ok !== true) throw new Error('插件安装失败: ' + JSON.stringify(installed).slice(0, 300))
  if (installed.data && installed.data.masterOff) {
    await main.eval('return await window.shopilot.extensions.setMaster(true)')
  }
  const reloaded = await main.eval(`return await window.shopilot.extensions.reload(${JSON.stringify(entry.id)})`)
  checker.check('插件已安装并重载到店铺会话', !!reloaded && reloaded.ok === true, `v${entry.version}`)

  // 2. 打开商品编辑页
  const before = new Set((await listTargets()).map(item => item.id))
  await main.eval(`return await window.shopilot.browser.open(${JSON.stringify(STORE_ID)}, { display: true })`)
  await sleep(700)
  const created = await main.eval(
    `return await window.shopilot.browser.tab.create(${JSON.stringify(STORE_ID)}, ${JSON.stringify(EDIT_URL)})`
  )
  checker.check('打开拼多多商品编辑页', !!created && created.ok === true, created && created.data && created.data.tabId)

  const page = await findPage(before)
  checker.check('内容脚本注入并出现悬浮按钮', !!page)
  if (!page) {
    main.close()
    return checker.summary('商品图片下载器 · 拼多多编辑页验收')
  }

  await sleep(2000)
  let launcher = null
  for (let i = 0; i < 25; i++) {
    launcher = await page.eval(`
      const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
      const el = root.querySelector('.launcher') || root.querySelector('.panel');
      if (!el) return null;
      const badge = root.querySelector('.launcher-badge');
      return { hasPanel: !!root.querySelector('.panel'), text: el.textContent.replace(/\\s+/g, ' ').trim(), badge: badge ? badge.textContent : '' };
    `)
    if (launcher && (launcher.hasPanel || launcher.badge === String(EXPECTED_TOTAL))) break
    await sleep(500)
  }
  checker.check(
    '悬浮按钮显示图片总数',
    !!launcher && (launcher.hasPanel || launcher.badge === String(EXPECTED_TOTAL)),
    launcher ? launcher.text.slice(0, 80) : '未找到'
  )

  // 3. 打开面板
  if (!launcher || !launcher.hasPanel) {
    await domClick(page, '.launcher', '点击「下载图片」')
    await sleep(700)
  }
  const panel = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const sections = [...root.querySelectorAll('.group-name')].map(node => node.textContent.replace(/\\s+/g, ' ').trim());
    const tiles = root.querySelectorAll('.tile').length;
    const selected = root.querySelectorAll('.tile.is-selected').length;
    const status = (root.querySelector('.status') || {}).textContent || '';
    const sub = (root.querySelector('.panel-sub') || {}).textContent || '';
    return { sections, tiles, selected, status: status.trim(), sub: sub.trim() };
  `)
  checker.check(
    `识别主图 ${EXPECTED_MAIN} 张 / 详情图 ${EXPECTED_DETAIL} 张`,
    panel.sections.join('|') === `主图 ${EXPECTED_MAIN}|详情图 ${EXPECTED_DETAIL}`,
    panel.sections.join(' / ')
  )
  checker.check(
    '缩略图全部识别且默认全选',
    panel.tiles === EXPECTED_TOTAL && panel.selected === EXPECTED_TOTAL,
    `${panel.selected}/${panel.tiles}`
  )
  checker.check('商品标题识别', panel.sub.includes('植绒小灯笼'), panel.sub.slice(0, 80))

  // 4. 悬停预览
  const hover = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const tile = root.querySelector('.tile');
    const preview = root.querySelector('.hover-preview');
    tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const visible = !preview.hidden;
    const src = preview.querySelector('img').src;
    const meta = preview.querySelector('.hover-preview-meta').textContent.trim();
    tile.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    return { visible, src, meta, hiddenAfter: preview.hidden };
  `)
  checker.check(
    '悬停缩略图显示原图预览',
    hover.visible && hover.src.includes('pddpic.com') && /主图 01/.test(hover.meta),
    hover.meta
  )
  checker.check('移出缩略图后预览收起', hover.hiddenAfter === true)

  // 5. 下载
  const startedAt = Date.now()
  const clicked = await domClick(page, '[data-act="download"]', '点击「下载选中」')
  let finalStatus = ''
  for (let i = 0; i < 150; i++) {
    await sleep(500)
    finalStatus = await page.eval(`
      const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
      const el = root.querySelector('.status');
      return el ? el.textContent.trim() : '';
    `)
    if (/已触发|张失败/.test(finalStatus)) break
  }
  checker.check(
    '下载任务完成且无失败',
    clicked && new RegExp(`已触发 ${EXPECTED_TOTAL} 张下载`).test(finalStatus),
    finalStatus || '超时未完成'
  )

  // 6. 应用下载管理器落盘
  await sleep(2500)
  const db = new Database(path.join(USER_DATA, 'shopilot.db'), { readonly: true, fileMustExist: true })
  const rows = db
    .prepare(
      `select file_name, file_path, size_bytes, state from downloads
       where created_at >= ? and store_id = ? order by created_at asc`
    )
    .all(startedAt - 2000, STORE_ID)
  db.close()

  const mainRows = rows.filter(row => /_主图_\d+(?:\(\d+\))?\./.test(row.file_name))
  const detailRows = rows.filter(row => /_详情图_\d+(?:\(\d+\))?\./.test(row.file_name))
  checker.check(`下载记录：主图 ${EXPECTED_MAIN} 条`, mainRows.length === EXPECTED_MAIN, mainRows.length + ' 条')
  checker.check(`下载记录：详情图 ${EXPECTED_DETAIL} 条`, detailRows.length === EXPECTED_DETAIL, detailRows.length + ' 条')
  checker.check(
    '下载记录全部 completed',
    rows.length > 0 && rows.every(row => row.state === 'completed' && row.size_bytes > 10 * 1024),
    rows.map(row => `${row.state}:${row.size_bytes}`).join(', ')
  )
  const missing = rows.filter(row => !row.file_path || !fs.existsSync(row.file_path))
  checker.check('磁盘文件存在', rows.length > 0 && missing.length === 0, missing.map(row => row.file_path).join(', '))
  checker.check(
    '文件名带商品标题与分组序号',
    rows.length >= EXPECTED_TOTAL &&
      rows.every(row => /植绒小灯笼.+_(主图|详情图)_\d{2}(?:\(\d+\))?\.jpg$/.test(row.file_name)),
    rows[0] ? rows[0].file_name : '无'
  )

  page.close()
  main.close()
  const ok = checker.summary('商品图片下载器 · 拼多多编辑页验收')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('验收异常：', error && error.stack ? error.stack : error)
  process.exit(1)
})
