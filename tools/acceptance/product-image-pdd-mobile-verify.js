/**
 * 商品图片下载器 · 拼多多手机商品页（rawData 图库）验收
 *
 * 为什么用 CDP 文档替换：mobile.yangkeduo.com/goods.html 当前要求消费者登录，
 * 店铺会话没有手机站登录态。这里用 CDP Fetch.fulfillRequest 在**真实手机站 URL**上
 * 返回一份带真实 gallery 结构（type 1/2/6/9 + 真实 PDD 图片 CDN 地址）的服务端页面，
 * 内容脚本、图库解析、悬停预览、下载与应用下载管理器全部走真实链路。
 *
 * 前置：应用以 --remote-debugging-port=9413 启动，拼多多店铺已登录。
 * 用法：node tools/acceptance/product-image-pdd-mobile-verify.js
 */
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const { CdpClient, waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const PORT = Number(process.env.SHOPILOT_CDP_PORT || 9413)
const STORE_ID = process.env.SHOPILOT_STORE_ID || 'store_93b6d25c1d1f47495b632e36200b2034'
const USER_DATA = process.env.SHOPILOT_USER_DATA || process.env.APPDATA + '\\shopilot'
const PLUGIN_KEY = 'product-image-downloader'
const GOODS_URL = 'https://mobile.yangkeduo.com/goods.html?goods_id=883203414380'
const TITLE = '植绒小灯笼挂饰新年春节喜庆装饰盆景阳台户外挂件教室灯笼布置'

const MAIN_IDS = [
  'cdf267d6-507a-42f9-a1b8-307edaed72d7',
  'c43ac4db-b489-4b5e-9669-074c446e5597',
  '57c41489-8aa9-4978-879e-bd2f956a4685',
  '089d96c3-d872-4aff-b926-6427e1ac3903',
  '4383d54d-ebf4-4e60-858f-fdc6169714e6',
  '738d1b44-2cd9-472f-9000-ba7fb560919f',
  '23640204-995c-479f-b8a8-dd9eda415f55',
  '5e0df927-be79-40cf-9705-28297fe7bf1c'
]
const DETAIL_IDS = [
  '8aec0899-cfc6-4566-9934-dd62cb5f9af0',
  '293913a5-7684-46d8-85ed-f0c7b6e0b2bb',
  'ef03c1f5-43a2-4c4d-b42c-cca61e8982a1',
  'd94f64a2-c866-476f-912b-7d6025548c3d',
  'd8ee2b28-1916-4cdb-bb8d-fe657069dea4',
  'afe236c6-71b5-409e-a846-d8b6e68183a2',
  '0fad6bce-a7cf-4768-8094-b3261db4bbf3',
  '38bf0b92-9def-43ec-b134-ad89f9a899b1'
]
const EXPECTED_MAIN = MAIN_IDS.length
const EXPECTED_DETAIL = DETAIL_IDS.length
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

function buildFixtureHtml() {
  const gallery = []
  MAIN_IDS.forEach((id, index) => {
    gallery.push({
      type: index === 0 ? 13 : 1,
      url: `https://img.pddpic.com/mms-material-img/2025-12-31/${id}.jpeg.a.jpeg?imageView2/2/w/800/q/85`,
      width: 800,
      height: 800
    })
  })
  // 同一张主图换一个处理参数：解析后必须去重
  gallery.push({
    type: 1,
    url: `https://img.pddpic.com/mms-material-img/2025-12-31/${MAIN_IDS[0]}.jpeg.a.jpeg?imageView2/2/w/400/q/80`,
    width: 800,
    height: 800
  })
  DETAIL_IDS.forEach(id => {
    gallery.push({
      type: 2,
      url: `https://img.pddpic.com/mms-material-img/2025-12-31/${id}.jpeg.a.jpeg?imageMogr2/quality/90/thumbnail/1300x9999%3E`,
      width: 790,
      height: 1300
    })
  })
  gallery.push({ type: 6, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/video.mp4' })
  gallery.push({ type: 9, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/desc.mp4' })
  const rawData = {
    store: {
      data: {
        goods: {
          goods_id: '883203414380',
          goods_name: TITLE,
          gallery
        }
      }
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body>
<div class="goods-title">${TITLE}</div>
<div class="goods-detail">商品详情</div>
<script>window.rawData=${JSON.stringify(rawData)};</script>
</body></html>`
}

async function findInjectedPage(beforeIds, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await listTargets()
    const target = list.find(
      item => !beforeIds.has(item.id) && (item.type === 'webview' || item.type === 'page')
    )
    if (target) {
      const page = new CdpClient(target.webSocketDebuggerUrl)
      await page.ready
      const found = await page.eval(
        'return !!document.getElementById("__shopilot_product_image_downloader__")'
      )
      if (found) return page
      page.close()
    }
    await sleep(800)
  }
  return null
}

async function main() {
  const main = await waitForMainWindow(PORT)
  if (!main) throw new Error('主窗口未出现（应用是否带 --remote-debugging-port 启动？）')
  if (!(await waitForShopilot(main))) throw new Error('渲染层 preload 未就绪（window.shopilot 不存在）')

  const catalog = await main.eval('return await window.shopilot.extensions.catalog()')
  const entries = (catalog && catalog.data && catalog.data.entries) || []
  const entry = entries.find(item => item.key === PLUGIN_KEY)
  checker.check('插件目录里存在 product-image-downloader', !!entry, entry ? `v${entry.version}` : '目录缺失')
  if (!entry) {
    main.close()
    return checker.summary('商品图片下载器 · 拼多多手机页验收')
  }
  if (!entry.installed || !entry.enabled) {
    await main.eval(`return await window.shopilot.extensions.installFromCatalog(${JSON.stringify(PLUGIN_KEY)})`)
  }
  const reloaded = await main.eval(`return await window.shopilot.extensions.reload(${JSON.stringify(entry.id)})`)
  checker.check('插件已安装并重载到店铺会话', !!reloaded && reloaded.ok === true, `v${entry.version}`)

  // 新建空白标签，用 CDP 文档替换模拟“已登录的手机商品页”
  const before = new Set((await listTargets()).map(item => item.id))
  await main.eval(`return await window.shopilot.browser.open(${JSON.stringify(STORE_ID)}, { display: true })`)
  await sleep(700)
  await main.eval(
    `return await window.shopilot.browser.tab.create(${JSON.stringify(STORE_ID)}, 'about:blank')`
  )
  main.close()

  let blank = null
  for (let i = 0; i < 30; i++) {
    await sleep(600)
    blank = (await listTargets()).find(
      item => !before.has(item.id) && (item.type === 'webview' || item.type === 'page')
    )
    if (blank) break
  }
  if (!blank) throw new Error('空白标签未出现')
  const page = new CdpClient(blank.webSocketDebuggerUrl)
  await page.ready

  const html = buildFixtureHtml()
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*goods.html*', requestStage: 'Request' }]
  })
  page.on('Fetch.requestPaused', async params => {
    try {
      if (String(params.request.url).includes('goods.html')) {
        await page.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(html, 'utf8').toString('base64')
        })
      } else {
        await page.send('Fetch.continueRequest', { requestId: params.requestId })
      }
    } catch {
      /* 页面/请求已结束 */
    }
  })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: GOODS_URL })
  await sleep(2500)

  const injected = await findInjectedPage(before)
  checker.check('内容脚本在手机商品页注入', !!injected)
  if (!injected) {
    page.close()
    return checker.summary('商品图片下载器 · 拼多多手机页验收')
  }

  const panel = await injected.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    if (!root.querySelector('.panel')) {
      const launcher = root.querySelector('.launcher');
      if (launcher) launcher.click();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const sections = [...root.querySelectorAll('.group-name')].map(node => node.textContent.replace(/\\s+/g, ' ').trim());
    const tiles = root.querySelectorAll('.tile').length;
    const selected = root.querySelectorAll('.tile.is-selected').length;
    const status = (root.querySelector('.status') || {}).textContent || '';
    const sub = (root.querySelector('.panel-sub') || {}).textContent || '';
    return { sections, tiles, selected, status: status.trim(), sub: sub.trim(), url: location.href };
  `)
  checker.check('页面 URL 仍是手机商品页', panel.url.includes('mobile.yangkeduo.com/goods.html') && panel.url.includes('goods_id=883203414380'), panel.url)
  checker.check(
    `rawData 图库：主图 ${EXPECTED_MAIN} / 详情图 ${EXPECTED_DETAIL}`,
    panel.sections.join('|') === `主图 ${EXPECTED_MAIN}|详情图 ${EXPECTED_DETAIL}`,
    panel.sections.join(' / ')
  )
  checker.check(
    '缩略图全部识别且默认全选（重复主图已去重）',
    panel.tiles === EXPECTED_TOTAL && panel.selected === EXPECTED_TOTAL,
    `${panel.selected}/${panel.tiles}`
  )
  checker.check('视频数量如实提示', panel.sub.includes('2 个视频未包含'), panel.sub.slice(0, 100))

  const hover = await injected.eval(`
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
  checker.check('悬停缩略图显示 PDD 原图预览', hover.visible && hover.src.includes('pddpic.com') && /主图 01/.test(hover.meta), hover.meta)
  checker.check('移出缩略图后预览收起', hover.hiddenAfter === true)

  const startedAt = Date.now()
  const clicked = await injected.eval(`
    const root = document.getElementById('__shopilot_product_image_downloader__').shadowRoot;
    const btn = root.querySelector('[data-act="download"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  `)
  checker.check('点击「下载选中」', clicked)
  let finalStatus = ''
  for (let i = 0; i < 150; i++) {
    await sleep(500)
    finalStatus = await injected.eval(`
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
      rows.every(row => new RegExp(`${TITLE}_(主图|详情图)_\\d{2}(?:\\(\\d+\\))?\\.jpg$`).test(row.file_name)),
    rows[0] ? rows[0].file_name : '无'
  )

  injected.close()
  page.close()
  const ok = checker.summary('商品图片下载器 · 拼多多手机页验收')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('验收异常：', error && error.stack ? error.stack : error)
  process.exit(1)
})
