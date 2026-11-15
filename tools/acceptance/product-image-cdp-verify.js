/**
 * 商品图片下载器 · 真机验收（CDP）
 *
 * 前置：应用以 --remote-debugging-port=9413 启动，抖店店铺已登录，且插件目录里有
 *       product-image-downloader（本脚本会自动安装并启用）。
 *
 * 验收链路（Runtime.evaluate 派发 DOM 点击，与应用既有验收脚本同一套做法）：
 *   打开商品详情页 → 右下角「下载图片」→ 面板识别 5 主图 + 6 详情图
 *   → 点「下载选中」→ 应用下载管理器落盘 → 校验 downloads 表与磁盘文件。
 *
 * 用法：node tools/acceptance/product-image-cdp-verify.js
 */
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const { CdpClient, waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const PORT = Number(process.env.SHOPILOT_CDP_PORT || 9413)
const STORE_ID = process.env.SHOPILOT_STORE_ID || 'store_485d9ec1e549231e555cc84bc5c59a81'
const TARGET_URL =
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

/** 应用刚启动时扩展文件偶发被占用，install 会失败；重试几次（插件中心真实用户也可重试）。 */
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

async function findPage() {
  for (let i = 0; i < 45; i++) {
    const list = await listTargets()
    const target = list.find(item => item.type !== 'worker' && String(item.url).includes('haohuo.jinritemai.com'))
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

/** 与应用既有验收同一口径：Runtime.evaluate 里点真实按钮，不猜像素坐标。 */
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

  // 1. 插件已安装并加载
  const catalog = await main.eval('return await window.shopilot.extensions.catalog()')
  const entries = (catalog && catalog.data && catalog.data.entries) || []
  const entry = entries.find(item => item.key === PLUGIN_KEY)
  checker.check('插件目录里存在 product-image-downloader', !!entry, entry ? `v${entry.version}` : '目录缺失')
  if (!entry) {
    main.close()
    return checker.summary('商品图片下载器验收')
  }
  // 每次都从插件目录重装一次：开发期插件文件会变，install 才会把新文件复制到 userData
  const installed = await installPlugin(main)
  checker.check('插件已安装/升级到目录版本', !!installed && installed.ok === true, `v${entry.version}`)
  if (installed && installed.data && installed.data.masterOff) {
    await main.eval('return await window.shopilot.extensions.setMaster(true)')
  }
  // 开发期改了插件文件：必须 reload 才会进已加载的店铺会话（install 不会刷新）
  const reloaded = await main.eval(
    `return await window.shopilot.extensions.reload(${JSON.stringify(entry.id)})`
  )
  if (!reloaded || reloaded.ok !== true) throw new Error('插件重载失败')

  // 2. 打开店铺与商品页（先关掉上一轮留下的 haohuo 标签，避免连到旧页面）
  await main.eval(`return await window.shopilot.browser.open(${JSON.stringify(STORE_ID)}, { display: true })`)
  await sleep(800)
  const state = await main.eval('return await window.shopilot.browser.state()')
  const storeState = (state.data && state.data.stores || []).find(item => item.storeId === STORE_ID)
  for (const tab of (storeState && storeState.tabs) || []) {
    if (String(tab.url || '').includes('haohuo.jinritemai.com')) {
      await main.eval(
        `return await window.shopilot.browser.tab.close(${JSON.stringify(STORE_ID)}, ${JSON.stringify(tab.id)})`
      )
    }
  }
  const created = await main.eval(
    `return await window.shopilot.browser.tab.create(${JSON.stringify(STORE_ID)}, ${JSON.stringify(TARGET_URL)})`
  )
  checker.check('打开商品详情页', !!created && created.ok === true, created && created.data && created.data.tabId)

  const page = await findPage()
  checker.check('内容脚本注入并出现悬浮按钮', !!page)
  if (!page) {
    main.close()
    return checker.summary('商品图片下载器验收')
  }

  await sleep(1500)
  let launcher = null
  for (let i = 0; i < 20; i++) {
    launcher = await page.eval(`
      const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
      const el = root.querySelector('.launcher') || root.querySelector('.panel');
      if (!el) return null;
      const badge = root.querySelector('.launcher-badge');
      return { hasPanel: !!root.querySelector('.panel'), text: el.textContent.replace(/\\s+/g, ' ').trim(), badge: badge ? badge.textContent : '' };
    `)
    if (launcher && (launcher.hasPanel || launcher.badge === '11')) break
    await sleep(500)
  }
  checker.check('悬浮按钮显示图片总数', !!launcher && (launcher.hasPanel || launcher.badge === '11'), launcher ? launcher.text.slice(0, 60) : '未找到')

  // 3. 打开面板（上一次验收可能已经开着）
  let opened = launcher && launcher.hasPanel
  if (!opened) {
    opened = await domClick(page, '.launcher', '点击「下载图片」')
    await sleep(700)
  } else {
    checker.check('点击「下载图片」', true, '面板已展开')
  }
  const panel = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const sections = [...root.querySelectorAll('.group-name')].map(node => node.textContent.replace(/\\s+/g, ' ').trim());
    const tiles = root.querySelectorAll('.tile').length;
    const selected = root.querySelectorAll('.tile.is-selected').length;
    const status = (root.querySelector('.status') || {}).textContent || '';
    return { sections, tiles, selected, status: status.trim(), hasPanel: !!root.querySelector('.panel') };
  `)
  checker.check('面板打开', opened && panel.hasPanel)
  checker.check(
    '识别主图 5 张 / 详情图 6 张',
    panel.sections.join('|') === '主图 5|详情图 6',
    panel.sections.join(' / ')
  )
  checker.check('缩略图 11 张且默认全选', panel.tiles === 11 && panel.selected === 11, `${panel.selected}/${panel.tiles}`)
  checker.check('已选计数按图片张数（主图1复用为详情1也不重复扣减）', /已选 11 \/ 11 张/.test(panel.status), panel.status)

  // 3.5 悬停放大：派发 pointerover/pointerout（与真实鼠标走同一监听）
  const hover = await page.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const tile = root.querySelector('.tile');
    const preview = root.querySelector('.hover-preview');
    const panelRect = root.querySelector('.panel').getBoundingClientRect();
    tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const rect = preview.getBoundingClientRect();
    const visible = !preview.hidden;
    const src = preview.querySelector('img').src;
    const meta = preview.querySelector('.hover-preview-meta').textContent.trim();
    tile.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    return { visible, src, meta, left: rect.left, right: rect.right, panelLeft: panelRect.left, hiddenAfter: preview.hidden };
  `)
  checker.check(
    '悬停缩略图显示原图预览',
    hover.visible && hover.src.includes('-image.image') && hover.meta.includes('主图 01'),
    hover.meta
  )
  checker.check('预览卡片在面板左侧且不重叠', hover.left >= 0 && hover.right <= hover.panelLeft, `${Math.round(hover.right)} <= ${Math.round(hover.panelLeft)}`)
  checker.check('移出缩略图后预览收起', hover.hiddenAfter === true)

  // 4. 下载
  const startedAt = Date.now()
  const clicked = await domClick(page, '[data-act="download"]', '点击「下载选中」')
  let finalStatus = ''
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    finalStatus = await page.eval(`
      const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
      const el = root.querySelector('.status');
      return el ? el.textContent.trim() : '';
    `)
    if (/已触发|张失败/.test(finalStatus)) break
  }
  checker.check('下载任务完成且无失败', clicked && /已触发 11 张下载/.test(finalStatus), finalStatus || '超时未完成')

  // 5. 应用下载管理器落盘
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
  checker.check('下载记录：主图 5 条', mainRows.length === 5, rows.map(row => row.file_name).join(', '))
  checker.check('下载记录：详情图 6 条', detailRows.length === 6, detailRows.length + ' 条')
  checker.check(
    '下载记录全部 completed',
    rows.length > 0 && rows.every(row => row.state === 'completed' && row.size_bytes > 10 * 1024),
    rows.map(row => `${row.state}:${row.size_bytes}`).join(', ')
  )
  const missing = rows.filter(row => !row.file_path || !fs.existsSync(row.file_path))
  checker.check('磁盘文件存在', rows.length > 0 && missing.length === 0, missing.map(row => row.file_path).join(', '))
  checker.check(
    '文件名带商品标题与分组序号',
    rows.length >= 11 &&
      rows.every(row => /2027新年福.+_(主图|详情图)_\d{2}(?:\(\d+\))?\.jpg$/.test(row.file_name)),
    rows[0] ? rows[0].file_name : '无'
  )

  page.close()
  main.close()
  const ok = checker.summary('商品图片下载器验收')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('验收异常：', error && error.stack ? error.stack : error)
  process.exit(1)
})
