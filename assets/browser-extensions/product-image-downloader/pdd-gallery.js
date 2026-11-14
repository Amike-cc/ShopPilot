/**
 * 拼多多商品图库解析（纯函数，可单测）
 *
 * 为什么单独成文件：拼多多把商品图库放在服务端渲染的 `window.rawData` 里，
 * 结构是 `{ goods: { gallery: [{ type, url, width, height }, ...] } }`，type 取值
 * （从 mobile 站 react_goods bundle 实测）：
 *   1 = 轮播主图, 2 = 详情图, 6 = 主图视频, 8 = 直播, 9 = 商详视频, 13 = 长主图
 *
 * 该文件用 UMD 包装：内容脚本里挂到 window.__productImagePddGallery，
 * Node 单测里可以 require，不需要 DOM。
 */
;(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.__productImagePddGallery = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const PDD_HOST_RE = /(^|\.)(pddpic\.com|yangkeduo\.com|pinduoduo\.com)$/i
  const IMAGE_TYPES = new Set(['1', '2', '6', '8', '9', '13'])

  function isPddImageHost(hostname) {
    return PDD_HOST_RE.test(String(hostname || ''))
  }

  /**
   * 拼多多图片地址统一：
   *   · 允许相对路径（图库数据里常见 `/mms-material-img/...`）；
   *   · 只认拼多多图片 CDN；
   *   · 去掉 imageView2 / imageMogr2 图片处理参数（拿原图；实测带不带参数源文件一致，
   *     去掉后地址更干净，也避免把缩略图当原图存）；
   *   · http 升级 https。
   */
  function normalizeImageUrl(raw, base) {
    const text = String(raw || '').trim()
    if (!text || text.startsWith('data:') || text.startsWith('blob:')) return ''
    let url
    try {
      url = new URL(text, base || 'https://mobile.yangkeduo.com')
    } catch {
      return ''
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!isPddImageHost(url.hostname)) return ''
    if (url.protocol === 'http:') url.protocol = 'https:'
    if (/imageView2|imageMogr2/i.test(url.search)) url.search = ''
    url.hash = ''
    return url.href
  }

  /** 从 `window.rawData={` 的 `{` 开始，按字符串/转义规则配对到完整 JSON。 */
  function extractJsonObject(text, start) {
    if (start < 0 || text[start] !== '{') return ''
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
    return ''
  }

  function looksLikeGallery(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) return false
    const candidates = items.filter(item => item && typeof item.url === 'string')
    if (!candidates.length) return false
    return candidates.every(item => IMAGE_TYPES.has(String(item.type)))
  }

  function findGalleryInfo(value, depth, parent) {
    if (!value || typeof value !== 'object' || depth > 12) return null
    if (Array.isArray(value)) {
      if (looksLikeGallery(value)) return { gallery: value, parent }
      for (const item of value) {
        const found = findGalleryInfo(item, depth + 1, null)
        if (found) return found
      }
      return null
    }
    if (looksLikeGallery(value.gallery)) return { gallery: value.gallery, parent: value }
    for (const key of Object.keys(value)) {
      const found = findGalleryInfo(value[key], depth + 1, value)
      if (found) return found
    }
    return null
  }

  function findTitle(value, depth) {
    if (!value || typeof value !== 'object' || depth > 12) return ''
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findTitle(item, depth + 1)
        if (found) return found
      }
      return ''
    }
    for (const key of ['goods_name', 'goodsName', 'share_desc', 'shareDesc']) {
      const text = typeof value[key] === 'string' ? value[key].trim() : ''
      if (text.length >= 4 && text.length <= 120 && /[\u4e00-\u9fa5]/.test(text)) return text
    }
    for (const key of Object.keys(value)) {
      const found = findTitle(value[key], depth + 1)
      if (found) return found
    }
    return ''
  }

  function pushUnique(list, seen, url) {
    if (!url || seen.has(url)) return
    seen.add(url)
    list.push({ url })
  }

  /** 把 gallery 数组按 type 分成主图 / 详情图；视频类只计数。 */
  function splitGallery(gallery, base) {
    const main = []
    const detail = []
    const seenMain = new Set()
    const seenDetail = new Set()
    let videoCount = 0
    for (const item of gallery || []) {
      if (!item || typeof item.url !== 'string') continue
      const type = String(item.type)
      if (type === '6' || type === '8' || type === '9') {
        videoCount++
        continue
      }
      if (type !== '1' && type !== '2' && type !== '13') continue
      const url = normalizeImageUrl(item.url, base)
      if (!url) continue
      if (type === '2') pushUnique(detail, seenDetail, url)
      else pushUnique(main, seenMain, url)
    }
    return { main, detail, videoCount }
  }

  /**
   * 从页面的 script 文本里读 `window.rawData`，找 gallery 与商品标题。
   * 读不到（没登录/纯客户端渲染）返回 null，由内容脚本走 DOM 兜底。
   */
  function parseScripts(scripts, base) {
    const list = Array.isArray(scripts) ? scripts : []
    for (const text of list) {
      const source = String(text || '')
      const marker = source.indexOf('window.rawData')
      if (marker < 0) continue
      const eq = source.indexOf('=', marker)
      const start = source.indexOf('{', eq)
      const json = extractJsonObject(source, start)
      if (!json) continue
      let data
      try {
        data = JSON.parse(json)
      } catch {
        continue
      }
      const info = findGalleryInfo(data, 0, null)
      if (!info) continue
      const split = splitGallery(info.gallery, base)
      if (!split.main.length && !split.detail.length) continue
      return {
        ...split,
        title: findTitle(info.parent || data, 0) || findTitle(data, 0),
        source: 'rawData'
      }
    }
    return null
  }

  return {
    normalizeImageUrl,
    extractJsonObject,
    looksLikeGallery,
    findGalleryInfo,
    splitGallery,
    parseScripts,
    isPddImageHost
  }
})
