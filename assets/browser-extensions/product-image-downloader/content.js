/**
 * 商品图片下载器 · content script
 *
 * 支持页面（2026-11-14/15 实测）：
 *   ① 抖店「商品详情预览」https://haohuo.jinritemai.com/ecommerce/trade/detail/...
 *      · 主图：.head-figure .swiper-slide > .head-figure__media-view__content
 *              图片是 inline style 的 background-image，不是 <img>；
 *      · 详情图：.product-big-img-list > img.product-big-img-list__every-img；
 *      · 标题：.title-info__text。
 *   ② 拼多多手机商品页 https://mobile.yangkeduo.com/goods.html?goods_id=...
 *      · 商品图库在服务端渲染的 window.rawData（goods.gallery，type 1/13=主图、2=详情图）；
 *      · rawData 读不到时用 DOM 兜底（pdd-lazy-image / data-src / 商品详情区块）。
 *   ③ 拼多多商家后台商品编辑页 https://mms.pinduoduo.com/goods/goods_add/...
 *      · 主图：轮播图卡片的 background-image；
 *      · 详情图：商品详情区块里的大图 <img>；
 *      · 不依赖手机站登录，便于商家直接取素材。
 *
 * 下载链路：本脚本 fetch（CDN 允许跨域）→ Blob → 页面 <a download>，
 * 由 ShopPilot 的下载管理器落盘（扩展不申请 downloads 权限，Electron 也未实现 chrome.downloads）。
 * fetch 被 CORS/页面策略挡住时，退回 background.js 的扩展上下文 fetch。
 *
 * 面板放在 Shadow DOM 里：页面 CSS（含 * 选择器）不会污染插件样式，插件也不会改页面布局。
 */
;(() => {
  'use strict'

  const HOST_ID = '__shopilot_product_image_downloader__'
  if (document.getElementById(HOST_ID)) return

  const CDN_HOST_RE = /(^|\.)(ecombdimg\.com|byteimg\.com|douyinpic\.com)$/i
  const PDD_HOST_RE = /(^|\.)(pddpic\.com|yangkeduo\.com|pinduoduo\.com)$/i
  const MAX_BYTES = 20 * 1024 * 1024

  function detectPlatform() {
    const host = location.hostname
    const path = location.pathname
    if (/(^|\.)haohuo\.jinritemai\.com$/i.test(host)) return 'haohuo'
    if (/(^|\.)yangkeduo\.com$/i.test(host) || /^mobile\.pinduoduo\.com$/i.test(host)) {
      return path === '/goods.html' ? 'pdd-mobile' : ''
    }
    if (/(^|\.)pinduoduo\.com$/i.test(host) && /^\/goods\/goods_add\//.test(path)) return 'pdd-mms'
    return ''
  }

  const PLATFORM = detectPlatform()
  if (!PLATFORM) return
  const IS_PDD = PLATFORM === 'pdd-mobile' || PLATFORM === 'pdd-mms'

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .app {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #111827;
      font-size: 12px;
      line-height: 1.4;
    }
    button { font-family: inherit; }

    .launcher {
      position: fixed; right: 18px; bottom: 88px;
      display: inline-flex; align-items: center; gap: 8px;
      height: 44px; padding: 0 14px;
      border: 0; border-radius: 999px;
      background: #111827; color: #fff;
      box-shadow: 0 10px 30px rgba(17, 24, 39, .28);
      cursor: pointer; pointer-events: auto;
      font-size: 13px; font-weight: 600;
    }
    .launcher:hover { background: #1f2937; }
    .launcher svg { width: 17px; height: 17px; }
    .launcher-badge {
      min-width: 20px; height: 20px; padding: 0 6px;
      border-radius: 999px; background: #fe2c55; color: #fff;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700;
    }

    .panel {
      position: fixed; right: 18px; top: 24px;
      width: 320px; max-height: calc(100vh - 48px);
      display: flex; flex-direction: column;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
      box-shadow: 0 18px 50px rgba(17, 24, 39, .22);
      overflow: hidden; pointer-events: auto;
    }
    .panel-head {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 12px 12px 10px; border-bottom: 1px solid #f3f4f6;
    }
    .head-main { flex: 1; min-width: 0; }
    .panel-title { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
    .panel-sub {
      margin-top: 3px; font-size: 11px; color: #6b7280;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .icon-btn {
      flex: none; width: 26px; height: 26px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 7px; background: transparent; color: #6b7280;
      cursor: pointer;
    }
    .icon-btn:hover { background: #f3f4f6; color: #111827; }
    .icon-btn svg { width: 15px; height: 15px; }

    .panel-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
    .group { padding-bottom: 2px; }
    .group-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px 6px;
    }
    .group-name { font-size: 12px; font-weight: 600; }
    .group-name em { font-style: normal; color: #fe2c55; }
    .group-actions { display: flex; gap: 2px; }
    .link-btn {
      border: 0; background: transparent; color: #6b7280;
      font-size: 11px; padding: 2px 5px; border-radius: 5px; cursor: pointer;
    }
    .link-btn:hover { color: #111827; background: #f3f4f6; }
    .link-btn.accent { color: #fe2c55; }
    .link-btn:disabled { opacity: .45; cursor: not-allowed; }

    .grid {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px; padding: 0 12px 4px;
    }
    .tile {
      position: relative; display: block; width: 100%; aspect-ratio: 1 / 1;
      padding: 0; border: 2px solid transparent; border-radius: 9px;
      background: #f3f4f6; overflow: hidden; cursor: pointer;
      transition: border-color .12s ease;
    }
    .tile:hover { border-color: #d1d5db; }
    .tile.is-selected { border-color: #fe2c55; }
    .tile img {
      display: block; width: 100%; height: 100%;
      object-fit: cover; pointer-events: none;
    }
    .tile-idx {
      position: absolute; left: 4px; bottom: 4px;
      padding: 0 4px; border-radius: 4px;
      background: rgba(17, 24, 39, .62); color: #fff;
      font-size: 9px; line-height: 14px;
    }
    .tile-check {
      position: absolute; top: 4px; right: 4px;
      width: 16px; height: 16px; border-radius: 50%;
      background: rgba(255, 255, 255, .92); border: 1px solid #d1d5db;
      display: flex; align-items: center; justify-content: center;
      color: transparent; font-size: 10px; font-weight: 700;
    }
    .tile.is-selected .tile-check { background: #fe2c55; border-color: #fe2c55; color: #fff; }
    .tile.is-selected .tile-check::after { content: "✓"; }
    .tile.is-failed { border-color: #f59e0b; }
    .tile.is-failed::after {
      content: "!"; position: absolute; right: 4px; bottom: 4px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #ef4444; color: #fff;
      font-size: 10px; font-weight: 700; line-height: 14px; text-align: center;
    }

    .empty { padding: 26px 16px; text-align: center; color: #9ca3af; font-size: 12px; }
    .empty .btn { margin-top: 10px; }

    .panel-foot {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-top: 1px solid #f3f4f6; background: #fff;
    }
    .status { flex: 1; min-width: 0; font-size: 11px; line-height: 1.35; color: #6b7280; }
    .status.is-ok { color: #059669; }
    .status.is-error { color: #dc2626; }
    .status.is-busy { color: #fe2c55; }
    .foot-actions { display: flex; gap: 6px; flex: none; }
    .btn {
      border-radius: 8px; padding: 7px 10px; cursor: pointer;
      font-size: 12px; font-weight: 600; border: 1px solid transparent;
      white-space: nowrap;
    }
    .btn.primary { background: #fe2c55; color: #fff; }
    .btn.primary:hover { background: #e11d48; }
    .btn.ghost { background: #fff; color: #374151; border-color: #d1d5db; }
    .btn.ghost:hover { background: #f9fafb; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .panel.is-busy .link-btn { opacity: .5; pointer-events: none; }

    /* 悬停预览：放在面板左侧，不挡缩略图本身；不接收鼠标事件，避免闪烁 */
    .hover-preview {
      position: fixed; left: 0; top: 0; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px; border: 1px solid #e5e7eb; border-radius: 12px;
      background: #fff; box-shadow: 0 18px 50px rgba(17, 24, 39, .28);
      pointer-events: none;
    }
    .hover-preview[hidden] { display: none; }
    .hover-preview img {
      display: block; width: auto; height: auto;
      max-width: 100%; max-height: min(68vh, 620px);
      object-fit: contain; border-radius: 6px; background: #f3f4f6;
    }
    .hover-preview-meta { font-size: 11px; color: #6b7280; text-align: center; }
  `

  const state = {
    images: { main: [], detail: [] },
    selection: new Set(),
    known: new Set(),
    failed: new Set(),
    productKey: '',
    signature: '',
    title: '',
    videoCount: 0,
    busy: false,
    open: false,
    status: '',
    tone: 'muted',
    lastHref: location.href
  }

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  const app = document.createElement('div')
  app.className = 'app'

  // 悬停大图预览：独立于 app，面板重渲染时不会被清掉
  const preview = document.createElement('div')
  preview.className = 'hover-preview'
  preview.hidden = true
  const previewImg = document.createElement('img')
  previewImg.alt = ''
  previewImg.decoding = 'async'
  const previewMeta = document.createElement('div')
  previewMeta.className = 'hover-preview-meta'
  preview.append(previewImg, previewMeta)

  shadow.append(style, app, preview)
  ;(document.documentElement || document.body).appendChild(host)

  /**
   * 主进程在保存位置弹窗关闭后会派发这个事件：detail 是 'ok' / 'cancel'。
   * 取消时插件要立刻停掉本批抓图与下载触发，并把状态改成“已取消下载”，
   * 不能只靠主进程丢文件而界面还显示成功。
   */
  let saveFolderResult = null
  document.addEventListener('__shopilot_image_save_result', event => {
    const detail = event && event.detail
    if (detail === 'ok' || detail === 'cancel') saveFolderResult = detail
  })

  /* ------------------------------------------------------------------ */
  /* 采集                                                                */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]
    })
  }

  /** inline style / computed style 里的第一个 url(...)。 */
  function firstBackgroundUrl(value) {
    const match = String(value || '').match(/url\((["']?)([^"')]+)\1\)/)
    return match ? match[2] : ''
  }

  /**
   * 统一图片地址：
   *   · 只认图片 CDN（站内图标、data: 一律忽略）；
   *   · 抖店 ecombdimg 的 `~tplv-xxx-resize...` 模板换成 `~tplv-xxx-image.image` 拿原图；
   *     签名域名（douyinpic 等）不动，改了会破坏签名；
   *   · 拼多多去掉 imageView2 / imageMogr2 处理参数，拿原图；
   *   · http 升级 https。
   */
  function normalizeImageUrl(raw) {
    if (IS_PDD) {
      const helper = window.__productImagePddGallery
      if (helper && typeof helper.normalizeImageUrl === 'function') {
        return helper.normalizeImageUrl(raw, location.origin)
      }
      const text = String(raw || '').trim()
      if (!text || text.startsWith('data:') || text.startsWith('blob:')) return ''
      let url
      try {
        url = new URL(text, location.origin)
      } catch {
        return ''
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      if (!PDD_HOST_RE.test(url.hostname)) return ''
      if (url.protocol === 'http:') url.protocol = 'https:'
      if (/imageView2|imageMogr2/i.test(url.search)) url.search = ''
      url.hash = ''
      return url.href
    }

    const text = String(raw || '').trim()
    if (!text || text.startsWith('data:') || text.startsWith('blob:')) return ''
    let url
    try {
      url = new URL(text, location.href)
    } catch {
      return ''
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!CDN_HOST_RE.test(url.hostname)) return ''
    if (url.protocol === 'http:') url.protocol = 'https:'
    if (/(^|\.)ecombdimg\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/^(.*)~tplv-([A-Za-z0-9]+)-[^/]*$/)
      if (match) url.pathname = `${match[1]}~tplv-${match[2]}-image.image`
    }
    url.hash = ''
    return url.href
  }

  function imageSource(img) {
    return (
      img.currentSrc ||
      img.src ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      ''
    )
  }

  function readHaohuoTitle() {
    const node =
      document.querySelector('.title-info__text') ||
      document.querySelector('[class*="title-info"] [class*="text"]') ||
      document.querySelector('[class*="title-info"]')
    const text = String((node && node.textContent) || document.title || '').trim()
    return (
      text
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '商品'
    )
  }

  function readPddMobileTitle() {
    const node =
      document.querySelector('[class*="goods-name"], [class*="goodsName"], [class*="goods-title"], [class*="goodsTitle"], h1')
    const text = String((node && node.textContent) || document.title || '').trim()
    const cleaned = text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned && !/^(拼多多|商品详情|商品)$/.test(cleaned)) return cleaned.slice(0, 60)
    return '商品'
  }

  /** 商家后台编辑页：标题在输入框里，取最长的中文输入值。 */
  function readPddMmsTitle() {
    const values = [...document.querySelectorAll('input')]
      .map(input => String(input.value || '').trim())
      .filter(value => value.length >= 6 && /[\u4e00-\u9fa5]/.test(value))
      .filter(value => !/[¥￥]/.test(value) && !/请输入|请选择/.test(value))
      .sort((a, b) => b.length - a.length)
    const title = values[0] || document.title || ''
    return (
      title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '商品'
    )
  }

  function readPageTitle() {
    if (PLATFORM === 'pdd-mobile') return readPddMobileTitle()
    if (PLATFORM === 'pdd-mms') return readPddMmsTitle()
    return readHaohuoTitle()
  }

  function productKey() {
    let id = ''
    try {
      const params = new URL(location.href).searchParams
      id = params.get('goods_id') || params.get('id') || ''
    } catch {
      id = ''
    }
    return `${PLATFORM}|${location.origin}${location.pathname}#${id}`
  }

  function isChromeImage(img) {
    let node = img
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
      const marker = `${node.className || ''} ${node.id || ''}`
      if (/comment|avatar|buyer|logo|icon|badge|star|shop-name/i.test(marker)) return true
      node = node.parentElement
    }
    return false
  }

  function isPddChromeImage(img) {
    let node = img
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      const marker = `${node.className || ''} ${node.id || ''}`
      if (
        /comment|review|avatar|buyer|logo|icon|badge|star|shop-name|recommend|similar|goods-list|goods-item|waterfall|qrcode|footer|header|sku/i.test(
          marker
        )
      ) {
        return true
      }
      node = node.parentElement
    }
    return false
  }

  /** 找「商品详情」区块标题，作为主图/详情图的分界。 */
  function findPddDetailAnchor() {
    const labels = ['商品详情', '详情介绍', '商品描述', '宝贝详情', '图文详情']
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = String(node.textContent || '').trim()
      if (!labels.includes(text)) continue
      const el = node.parentElement
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const top = rect.top + window.scrollY
      if (top < 200) continue
      return { el, top }
    }
    return null
  }

  /**
   * 拼多多手机页 DOM 兜底：rawData 读不到时，按图片 CDN + 尺寸 + 「商品详情」分界。
   * 主图优先取 mms-material-img 素材图，排除推荐位/评论/头像。
   */
  function collectPddMobileDom() {
    const candidates = []
    const seen = new Set()
    const add = (raw, el) => {
      const url = normalizeImageUrl(raw)
      if (!url || seen.has(url)) return
      if (isPddChromeImage(el)) return
      const rect = el.getBoundingClientRect()
      const isImg = el.tagName === 'IMG'
      const width = isImg ? el.naturalWidth || rect.width : rect.width
      const height = isImg ? el.naturalHeight || rect.height : rect.height
      if (width < 160 || height < 160) return
      seen.add(url)
      candidates.push({ url, top: rect.top + window.scrollY, width, height })
    }
    document.querySelectorAll('img').forEach(img => add(imageSource(img), img))
    document.querySelectorAll('[style*="background-image"]').forEach(el => {
      add(firstBackgroundUrl(getComputedStyle(el).backgroundImage || el.style.backgroundImage), el)
    })

    // 商品素材图优先；一个都没有时退回其它 CDN 大图
    let pool = candidates.filter(item => /\/mms-material-img\//i.test(item.url))
    if (pool.length < 2) pool = candidates
    pool.sort((a, b) => a.top - b.top)

    const anchor = findPddDetailAnchor()
    const main = []
    const detail = []
    for (const item of pool) {
      const isDetail = anchor ? item.top >= anchor.top - 24 : item.top >= 1200
      if (isDetail) detail.push({ url: item.url })
      else main.push({ url: item.url })
    }

    // 没有分界标题时，首屏大图里最多取 10 张当主图，其余归详情
    if (!anchor && main.length > 10) {
      detail.unshift(...main.splice(10))
    }
    if (!main.length && detail.length) {
      main.push(...detail.splice(0, Math.min(10, detail.length)))
    }
    return {
      main,
      detail,
      title: readPddMobileTitle(),
      videoCount: document.querySelectorAll('video').length,
      key: productKey()
    }
  }

  function collectPddMobile() {
    const helper = window.__productImagePddGallery
    if (helper && typeof helper.parseScripts === 'function') {
      const scripts = [...document.querySelectorAll('script')].map(script => script.textContent || '')
      const parsed = helper.parseScripts(scripts, location.origin)
      if (parsed && (parsed.main.length || parsed.detail.length)) {
        return {
          main: parsed.main,
          detail: parsed.detail,
          title: parsed.title || readPddMobileTitle(),
          videoCount: parsed.videoCount || 0,
          key: productKey()
        }
      }
    }
    return collectPddMobileDom()
  }

  /** 商家后台编辑页：轮播图卡片背景 + 商品详情区块大图。 */
  function collectPddMms() {
    const main = []
    const detail = []
    const seenMain = new Set()
    const seenDetail = new Set()
    const pushMain = raw => {
      const url = normalizeImageUrl(raw)
      if (!url || seenMain.has(url)) return
      if (!/\/mms-material-img\//i.test(url)) return
      if (/\.mp4/i.test(url)) return
      seenMain.add(url)
      main.push({ url })
    }
    const pushDetail = raw => {
      const url = normalizeImageUrl(raw)
      if (!url || seenDetail.has(url)) return
      if (!/\/mms-material-img\//i.test(url)) return
      if (/\.mp4/i.test(url)) return
      seenDetail.add(url)
      detail.push({ url })
    }

    // 主图：商品轮播图卡片的 background-image（白底图在 aigc-img，已被上面的素材图过滤挡掉）
    document.querySelectorAll('[class*="MaterialModalButton"][class*="imageBox"]').forEach(el => {
      pushMain(firstBackgroundUrl(getComputedStyle(el).backgroundImage || el.style.backgroundImage))
    })

    // 详情图：商品详情区块里的大图；有标题时按「商品详情 → 规格与库存」区间收
    const anchor = findPddDetailAnchor()
    const endLabel = [...document.querySelectorAll('*')].find(el => {
      if (String(el.textContent || '').trim() !== '规格与库存') return false
      const top = el.getBoundingClientRect().top + window.scrollY
      return !anchor || top > anchor.top
    })
    const endTop = endLabel ? endLabel.getBoundingClientRect().top + window.scrollY : Infinity
    document.querySelectorAll('img').forEach(img => {
      const url = normalizeImageUrl(imageSource(img))
      if (!url) return
      if ((img.naturalWidth || 0) < 600) return
      if (!anchor) {
        pushDetail(url)
        return
      }
      const top = img.getBoundingClientRect().top + window.scrollY
      if (top >= anchor.top - 24 && top <= endTop + 24) pushDetail(url)
    })

    // 主图若也以 <img> 出现（改版兜底）：取轮播区里的大图，再从详情里剔重
    document.querySelectorAll('img').forEach(img => {
      const url = normalizeImageUrl(imageSource(img))
      if (!url || !/\/mms-material-img\//i.test(url)) return
      if ((img.naturalWidth || 0) < 400) return
      const top = img.getBoundingClientRect().top + window.scrollY
      if (anchor && top >= anchor.top - 24) return
      if (top < 1400) pushMain(url)
    })

    return {
      main,
      detail: detail.filter(item => !seenMain.has(item.url)),
      title: readPddMmsTitle(),
      videoCount: 0,
      key: productKey()
    }
  }

  function collectImages() {
    if (PLATFORM === 'pdd-mobile') return collectPddMobile()
    if (PLATFORM === 'pdd-mms') return collectPddMms()
    return collectHaohuo()
  }

  function collectHaohuo() {
    const main = []
    const detail = []
    const seenMain = new Set()
    const seenDetail = new Set()

    const pushMain = raw => {
      const url = normalizeImageUrl(raw)
      if (!url || seenMain.has(url)) return
      seenMain.add(url)
      main.push({ url })
    }
    const pushDetail = raw => {
      const url = normalizeImageUrl(raw)
      if (!url || seenDetail.has(url)) return
      seenDetail.add(url)
      detail.push({ url })
    }

    // 主图：轮播里用背景图承载；也兼容改成 <img> / <video poster> 的情况。
    const headRoot =
      document.querySelector('.head-figure') ||
      document.querySelector('[class*="head-figure"]')
    if (headRoot) {
      headRoot.querySelectorAll('[style*="background-image"]').forEach(el => {
        pushMain(firstBackgroundUrl(getComputedStyle(el).backgroundImage || el.style.backgroundImage))
      })
      headRoot.querySelectorAll('img').forEach(img => pushMain(imageSource(img)))
    }

    // 详情图：详情描述的大图列表。
    let detailRoots = document.querySelectorAll(
      '.product-big-img-list, [class*="product-big-img-list"]'
    )
    if (!detailRoots.length) detailRoots = document.querySelectorAll('[class*="big-img-list"]')
    detailRoots.forEach(root => {
      if (root.tagName === 'IMG') pushDetail(imageSource(root))
      root.querySelectorAll('img').forEach(img => pushDetail(imageSource(img)))
    })

    // 兜底：类名改版时，按 CDN + 尺寸 + 位置分类（跳过评论/头像/店铺图标）。
    if (!main.length || !detail.length) {
      const headRect = headRoot ? headRoot.getBoundingClientRect() : null
      const headBottom = headRect ? headRect.top + window.scrollY + headRect.height : 0
      const pool = []
      document.querySelectorAll('img').forEach(img => {
        if (isChromeImage(img)) return
        if (img.naturalWidth && img.naturalWidth < 300) return
        const url = normalizeImageUrl(imageSource(img))
        if (!url) return
        const rect = img.getBoundingClientRect()
        if (!rect.width && !rect.height) return
        pool.push({ url, top: rect.top + window.scrollY, width: img.naturalWidth || rect.width })
      })
      const headImages = headBottom
        ? pool.filter(item => item.top < headBottom)
        : pool.filter(item => item.top < 1200)
      if (!main.length) headImages.forEach(item => pushMain(item.url))
      if (!detail.length) pool.forEach(item => pushDetail(item.url))
    }

    let videoCount = 0
    if (headRoot) videoCount = headRoot.querySelectorAll('video').length

    return { main, detail, title: readPageTitle(), videoCount, key: productKey() }
  }

  /* ------------------------------------------------------------------ */
  /* 面板                                                                */
  /* ------------------------------------------------------------------ */

  const DOWNLOAD_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>'
  const CLOSE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>'
  const REFRESH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'

  function allImages() {
    return [...state.images.main, ...state.images.detail]
  }

  /**
   * 选择/失败状态必须按「分组 + URL」作为键：同一张图可能同时出现在主图和详情
   * （本商品第 1 张主图就复用在详情第一张），只按 URL 去重会让两张缩略图联动、
   * 已选数量少 1。
   */
  function itemKey(item) {
    return `${item.group}|${item.url}`
  }

  function selectedItems() {
    return allImages().filter(item => state.selection.has(itemKey(item)))
  }

  function groupLabel(group) {
    return group === 'main' ? '主图' : '详情图'
  }

  function pad(index) {
    return String(index).padStart(2, '0')
  }

  function tileHtml(item) {
    const key = itemKey(item)
    const selected = state.selection.has(key)
    const failed = state.failed.has(key)
    const url = escapeHtml(item.url)
    return (
      `<button type="button" class="tile${selected ? ' is-selected' : ''}${
        failed ? ' is-failed' : ''
      }" data-key="${escapeHtml(key)}" title="${groupLabel(item.group)} ${pad(item.index)}">` +
      `<img src="${url}" alt="" loading="lazy" draggable="false">` +
      `<span class="tile-idx">${pad(item.index)}</span>` +
      '<span class="tile-check"></span>' +
      '</button>'
    )
  }

  function sectionHtml(group) {
    const items = state.images[group]
    if (!items.length) return ''
    const allSelected = items.every(item => state.selection.has(itemKey(item)))
    return (
      '<section class="group">' +
      '<div class="group-head">' +
      `<span class="group-name">${groupLabel(group)} <em>${items.length}</em></span>` +
      '<span class="group-actions">' +
      `<button type="button" class="link-btn" data-act="all-${group}">${
        allSelected ? '取消全选' : '全选'
      }</button>` +
      `<button type="button" class="link-btn accent" data-act="dl-${group}">下载本组</button>` +
      '</span></div>' +
      `<div class="grid">${items.map(tileHtml).join('')}</div>` +
      '</section>'
    )
  }

  function panelHtml() {
    const total = allImages().length
    const videoNote = state.videoCount ? ` · ${state.videoCount} 个视频未包含` : ''
    const sub = `${state.title || '商品图片'}｜主图 ${state.images.main.length} · 详情 ${state.images.detail.length}${videoNote}`
    const body = total
      ? sectionHtml('main') + sectionHtml('detail')
      : '<div class="empty">还没有识别到商品图片<br>页面加载完成后点下方刷新' +
        '<div><button type="button" class="btn ghost" data-act="refresh">刷新识别</button></div></div>'
    const selected = state.selection.size
    const statusText = state.status || `已选 ${selected} / ${total} 张`
    return (
      `<div class="panel${state.busy ? ' is-busy' : ''}">` +
      '<div class="panel-head">' +
      '<div class="head-main">' +
      '<div class="panel-title">商品图片下载</div>' +
      `<div class="panel-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>` +
      '</div>' +
      `<button type="button" class="icon-btn" data-act="refresh" title="重新识别">${REFRESH_ICON}</button>` +
      `<button type="button" class="icon-btn" data-act="close" title="收起">${CLOSE_ICON}</button>` +
      '</div>' +
      `<div class="panel-body">${body}</div>` +
      '<div class="panel-foot">' +
      `<div class="status${state.tone !== 'muted' ? ' is-' + state.tone : ''}">${escapeHtml(
        statusText
      )}</div>` +
      '<div class="foot-actions">' +
      `<button type="button" class="btn ghost" data-act="copy"${selected ? '' : ' disabled'}>复制链接</button>` +
      `<button type="button" class="btn primary" data-act="download"${
        state.busy || !selected ? ' disabled' : ''
      }>下载选中 (${selected})</button>` +
      '</div></div></div>'
    )
  }

  function launcherHtml() {
    const total = allImages().length
    return (
      `<button type="button" class="launcher" data-act="open" title="下载主图 / 详情图">` +
      DOWNLOAD_ICON +
      '<span>下载图片</span>' +
      `<span class="launcher-badge">${total}</span>` +
      '</button>'
    )
  }

  function render(options) {
    hidePreview()
    const opts = options || {}
    const total = allImages().length
    if (!state.open && !total) {
      host.style.display = 'none'
      return
    }
    host.style.display = 'block'
    const previousBody = app.querySelector('.panel-body')
    const previousScroll = previousBody ? previousBody.scrollTop : 0
    app.innerHTML = state.open ? panelHtml() : launcherHtml()
    const nextBody = app.querySelector('.panel-body')
    if (nextBody && opts.keepScroll) nextBody.scrollTop = previousScroll
  }

  function syncTiles() {
    if (!state.open) return
    app.querySelectorAll('.tile').forEach(tile => {
      const key = tile.dataset.key
      tile.classList.toggle('is-selected', state.selection.has(key))
      tile.classList.toggle('is-failed', state.failed.has(key))
    })
  }

  function syncFooter() {
    if (!state.open) return
    const selected = state.selection.size
    const status = app.querySelector('.status')
    if (status && !state.status) {
      status.textContent = `已选 ${selected} / ${allImages().length} 张`
      status.className = 'status'
    }
    const download = app.querySelector('[data-act="download"]')
    if (download) {
      download.disabled = state.busy || selected === 0
      download.textContent = `下载选中 (${selected})`
    }
    const copy = app.querySelector('[data-act="copy"]')
    if (copy) copy.disabled = selected === 0
    const panel = app.querySelector('.panel')
    if (panel) panel.classList.toggle('is-busy', state.busy)
    // 单张勾选只走 syncTiles，不会重渲染 group 头：这里把「全选/取消全选」文案补上
    for (const group of ['main', 'detail']) {
      const button = app.querySelector(`[data-act="all-${group}"]`)
      if (!button) continue
      const items = state.images[group]
      const allSelected = items.length > 0 && items.every(item => state.selection.has(itemKey(item)))
      button.textContent = allSelected ? '取消全选' : '全选'
    }
  }

  function setStatus(text, tone) {
    state.status = text
    state.tone = tone || 'muted'
    const status = app.querySelector('.status')
    if (status) {
      status.textContent = text
      status.className = `status${state.tone !== 'muted' ? ' is-' + state.tone : ''}`
    }
  }

  function clearStatus() {
    state.status = ''
    state.tone = 'muted'
  }

  /* ------------------------------------------------------------------ */
  /* 悬停放大                                                            */
  /* ------------------------------------------------------------------ */

  let previewTile = null

  function findItemByKey(key) {
    return allImages().find(item => itemKey(item) === key) || null
  }

  function hidePreview() {
    previewTile = null
    if (!preview.hidden) preview.hidden = true
  }

  /** 预览卡片贴在面板左侧，纵向跟随悬停缩略图；空间不足时夹在视口内。 */
  function positionPreview(tile) {
    if (!tile || !tile.isConnected) return
    const panel = app.querySelector('.panel')
    if (!panel) return
    const panelRect = panel.getBoundingClientRect()
    const tileRect = tile.getBoundingClientRect()
    const maxWidth = Math.max(220, Math.min(420, panelRect.left - 24))
    preview.style.maxWidth = `${Math.round(maxWidth)}px`
    const previewRect = preview.getBoundingClientRect()
    let left = panelRect.left - previewRect.width - 14
    if (left < 8) left = 8
    let top = tileRect.top + tileRect.height / 2 - previewRect.height / 2
    top = Math.max(12, Math.min(top, window.innerHeight - previewRect.height - 12))
    preview.style.left = `${Math.round(left)}px`
    preview.style.top = `${Math.round(top)}px`
  }

  function showPreview(tile) {
    const item = findItemByKey(tile.dataset.key)
    if (!item) return
    previewTile = tile
    const thumb = tile.querySelector('img')
    const width = thumb ? thumb.naturalWidth : 0
    const height = thumb ? thumb.naturalHeight : 0
    const label = `${groupLabel(item.group)} ${pad(item.index)}`
    previewMeta.textContent = width && height ? `${label} · ${width} × ${height}` : label
    if (previewImg.src !== item.url) previewImg.src = item.url
    preview.hidden = false
    positionPreview(tile)
  }

  previewImg.addEventListener('load', () => {
    if (previewTile) positionPreview(previewTile)
  })

  /* ------------------------------------------------------------------ */
  /* 刷新 / 列表                                                         */
  /* ------------------------------------------------------------------ */

  function refresh(force) {
    const collected = collectImages()
    const signature = [
      collected.key,
      collected.title,
      collected.main.map(item => item.url).join('|'),
      collected.detail.map(item => item.url).join('|')
    ].join('#')
    if (!force && signature === state.signature) return

    const productChanged = collected.key !== state.productKey
    state.productKey = collected.key
    state.signature = signature
    state.title = collected.title
    state.videoCount = collected.videoCount

    if (productChanged) {
      state.known.clear()
      state.selection.clear()
      state.failed.clear()
      clearStatus()
    }

    state.images = {
      main: collected.main.map((item, index) => ({ url: item.url, group: 'main', index: index + 1 })),
      detail: collected.detail.map((item, index) => ({
        url: item.url,
        group: 'detail',
        index: index + 1
      }))
    }

    const all = allImages()
    const alive = new Set(all.map(item => itemKey(item)))
    for (const item of all) {
      const key = itemKey(item)
      if (state.known.has(key)) continue
      state.known.add(key)
      state.selection.add(key)
    }
    for (const key of [...state.selection]) if (!alive.has(key)) state.selection.delete(key)
    for (const key of [...state.known]) if (!alive.has(key)) state.known.delete(key)

    render({ keepScroll: true })
  }

  /* ------------------------------------------------------------------ */
  /* 下载                                                                */
  /* ------------------------------------------------------------------ */

  function extensionFor(mime, url) {
    const type = String(mime || '').toLowerCase()
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
    if (type.includes('png')) return 'png'
    if (type.includes('webp')) return 'webp'
    if (type.includes('gif')) return 'gif'
    if (type.includes('avif')) return 'avif'
    if (type.includes('heic')) return 'heic'
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      path = ''
    }
    if (/\.image$/i.test(path)) return 'jpg'
    const match = path.match(/\.([a-z0-9]{2,5})$/i)
    return match ? match[1].toLowerCase() : 'jpg'
  }

  function buildFilename(title, item, mime) {
    const safeTitle =
      String(title || '商品')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '商品'
    return `${safeTitle}_${groupLabel(item.group)}_${pad(item.index)}.${extensionFor(
      mime,
      item.url
    )}`
  }

  function base64ToBlob(b64, mime) {
    const bin = atob(String(b64 || ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
  }

  function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'IMGDL_FETCH', url }, response => {
          const lastError = chrome.runtime.lastError
          if (lastError) {
            reject(new Error(lastError.message || '后台通道不可用'))
            return
          }
          if (!response || response.ok !== true) {
            reject(new Error((response && response.error) || '后台通道下载失败'))
            return
          }
          resolve(response)
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async function fetchImage(url) {
    try {
      const response = await fetch(url, { credentials: 'omit' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.size) throw new Error('文件为空')
      if (blob.size > MAX_BYTES) throw new Error('图片超过 20MB')
      return { blob, mime: blob.type || '' }
    } catch (first) {
      try {
        const viaBackground = await fetchViaBackground(url)
        const blob = base64ToBlob(viaBackground.b64, viaBackground.mime)
        if (!blob.size) throw new Error('文件为空')
        return { blob, mime: viaBackground.mime || '' }
      } catch (second) {
        throw new Error(
          `${(first && first.message) || first}；备用通道：${(second && second.message) || second}`
        )
      }
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    ;(document.body || document.documentElement).appendChild(anchor)
    anchor.click()
    // 10 分钟后回收：下载管理器可能还在读这个 Blob（与罗盘插件同一策略）
    setTimeout(() => {
      try {
        anchor.remove()
      } catch {}
      try {
        URL.revokeObjectURL(url)
      } catch {}
    }, 10 * 60 * 1000)
  }

  /**
   * Chromium 对「同一页面短时间连续触发的下载」有节流：实测 11 张一次性点击时
   * 第 11 张不会进 will-download（应用下载面板只有 10 条），表现为静默丢一张。
   * 这里把 <a download> 的触发串行化，并每 8 张停 2 秒，让下载队列先消化。
   */
  let downloadGate = Promise.resolve()
  let burstCount = 0
  function enqueueDownload(blob, filename) {
    const task = downloadGate.then(async () => {
      triggerDownload(blob, filename)
      burstCount++
      if (burstCount >= 8) {
        burstCount = 0
        await new Promise(resolve => setTimeout(resolve, 2000))
      } else {
        await new Promise(resolve => setTimeout(resolve, 350))
      }
    })
    downloadGate = task.catch(() => {})
    return task
  }

  async function downloadItems(items) {
    if (state.busy) return
    if (!items.length) {
      setStatus('没有可下载的图片', 'error')
      return
    }
    const total = items.length
    state.busy = true
    saveFolderResult = null
    state.failed.clear()
    clearStatus()
    setStatus(`准备下载 ${total} 张…`, 'busy')
    syncFooter()
    syncTiles()

    const finishCancelled = () => {
      state.busy = false
      syncFooter()
      syncTiles()
      setStatus('已取消下载（未选择保存文件夹）', 'error')
    }

    // 先让应用弹「选择保存位置」：0 字节 marker 被主进程拦截，不落盘、不写下载记录。
    // 每次点击都会重新问一次；这一批图片在用户选定文件夹后才开始落盘。
    setStatus('请选择图片保存文件夹…', 'busy')
    try {
      await enqueueDownload(new Blob([''], { type: 'text/plain' }), '__shopilot_pick_folder__.txt')
    } catch {
      /* 应用不认 marker 时继续走默认下载目录 */
    }
    if (saveFolderResult === 'cancel') {
      finishCancelled()
      return
    }

    const title = state.title || readPageTitle()
    const queue = items.slice()
    let done = 0
    let failed = 0

    const worker = async () => {
      while (queue.length) {
        if (saveFolderResult === 'cancel') {
          queue.length = 0
          break
        }
        const item = queue.shift()
        try {
          setStatus(
            `正在下载 ${done + failed + 1}/${total} · ${groupLabel(item.group)} ${pad(item.index)}`,
            'busy'
          )
          const result = await fetchImage(item.url)
          if (saveFolderResult === 'cancel') break
          await enqueueDownload(result.blob, buildFilename(title, item, result.mime))
          done++
        } catch (error) {
          failed++
          state.failed.add(itemKey(item))
          console.warn('[商品图片下载] 下载失败', item.url, error)
          syncTiles()
        }
      }
    }

    await Promise.all([worker(), worker()])
    if (saveFolderResult === 'cancel') {
      finishCancelled()
      return
    }
    state.busy = false
    syncFooter()
    syncTiles()
    if (failed) {
      setStatus(`已触发 ${done} 张，${failed} 张失败（带红点的图可再次下载）`, 'error')
    } else {
      setStatus(`已触发 ${done} 张下载；在保存位置弹窗中取消则不会落盘，右侧栏「下载」可查看`, 'ok')
    }
  }

  /* ------------------------------------------------------------------ */
  /* 复制链接                                                            */
  /* ------------------------------------------------------------------ */

  async function copySelected() {
    const urls = [...new Set(selectedItems().map(item => item.url))]
    if (!urls.length) {
      setStatus('没有选中的图片', 'error')
      return
    }
    const text = urls.join('\n')
    let copied = false
    try {
      await navigator.clipboard.writeText(text)
      copied = true
    } catch {}
    if (!copied) {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
        ;(document.body || document.documentElement).appendChild(textarea)
        textarea.select()
        copied = document.execCommand('copy')
        textarea.remove()
      } catch {}
    }
    setStatus(copied ? `已复制 ${urls.length} 条链接` : '复制失败，请重试', copied ? 'ok' : 'error')
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function toggleTile(key) {
    if (!key) return
    if (state.selection.has(key)) state.selection.delete(key)
    else state.selection.add(key)
    clearStatus()
    syncTiles()
    syncFooter()
  }

  function toggleGroup(group) {
    const items = state.images[group]
    if (!items.length) return
    const allSelected = items.every(item => state.selection.has(itemKey(item)))
    for (const item of items) {
      const key = itemKey(item)
      if (allSelected) state.selection.delete(key)
      else state.selection.add(key)
    }
    clearStatus()
    syncTiles()
    syncFooter()
    render({ keepScroll: true })
  }

  shadow.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const tile = target.closest('.tile')
    if (tile) {
      event.preventDefault()
      event.stopPropagation()
      toggleTile(tile.dataset.key)
      return
    }
    const button = target.closest('[data-act]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const action = button.dataset.act
    if (action === 'open') {
      state.open = true
      clearStatus()
      render({ keepScroll: true })
      return
    }
    if (action === 'close') {
      state.open = false
      render()
      return
    }
    if (action === 'refresh') {
      clearStatus()
      refresh(true)
      setStatus('已重新识别', 'ok')
      return
    }
    if (action === 'download') {
      downloadItems(selectedItems())
      return
    }
    if (action === 'copy') {
      copySelected()
      return
    }
    if (action === 'all-main') {
      toggleGroup('main')
      return
    }
    if (action === 'all-detail') {
      toggleGroup('detail')
      return
    }
    if (action === 'dl-main') {
      downloadItems(state.images.main.slice())
      return
    }
    if (action === 'dl-detail') {
      downloadItems(state.images.detail.slice())
    }
  })

  shadow.addEventListener('mousedown', event => {
    // 不让页面把面板里的点击当成页面手势（轮播拖动等）
    event.stopPropagation()
  })
  shadow.addEventListener('wheel', event => {
    event.stopPropagation()
  })

  shadow.addEventListener('pointerover', event => {
    const target = event.target instanceof Element ? event.target : null
    const tile = target && target.closest('.tile')
    if (!tile || tile === previewTile) return
    showPreview(tile)
  })

  shadow.addEventListener('pointerout', event => {
    const target = event.target instanceof Element ? event.target : null
    const tile = target && target.closest('.tile')
    if (!tile) return
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : null
    if (related && related.closest('.tile') === tile) return
    hidePreview()
  })

  // 面板滚动/窗口尺寸变化后缩略图位置会变，预览先收起，避免停在错位处
  shadow.addEventListener('scroll', hidePreview, true)
  window.addEventListener('resize', hidePreview)

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  let refreshTimer = null
  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refresh(false)
    }, 700)
  }

  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'src']
  })

  // 页面是 SPA：地址变了要重算商品键
  setInterval(() => {
    if (location.href === state.lastHref) return
    state.lastHref = location.href
    state.productKey = ''
    state.signature = ''
    refresh(true)
  }, 1000)

  // 首屏内容可能还在渲染：前 15 秒每 800ms 补一次
  let attempts = 0
  const bootTimer = setInterval(() => {
    attempts++
    refresh(false)
    if (attempts >= 19) clearInterval(bootTimer)
  }, 800)

  refresh(true)
})()
