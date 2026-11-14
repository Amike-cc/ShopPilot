/**
 * 商品图片下载器（内置插件）契约测试（2026-11-15）。
 *
 * 这个插件是随包发的静态资产，没有 TS 编译兜底；最容易坏在「改了文件忘了改清单」、
 * 「不小心申请 downloads 权限」、「内容脚本/后台文件缺失」。这里钉住这些约束，
 * 具体页面交互由 tools/acceptance/product-image-cdp-verify.js 真机验收。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCatalogIndex } from '@shared/extension-catalog'
import { validateExtensionManifest } from '../../apps/desktop/src/main/services/extension-manifest'

const ROOT = resolve(__dirname, '../..')
const CATALOG_ROOT = join(ROOT, 'assets', 'browser-extensions')
const PLUGIN_DIR = join(CATALOG_ROOT, 'product-image-downloader')

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

interface TestManifest {
  content_scripts?: Array<{ matches?: string[]; js?: string[]; world?: string }>
  background?: { service_worker?: string }
  permissions?: string[]
  optional_permissions?: string[]
}

function readManifest(): TestManifest {
  return readJson(join(PLUGIN_DIR, 'manifest.json')) as TestManifest
}

describe('商品图片下载器（product-image-downloader）', () => {
  it('catalog.json 已登记且目录/manifest 合法', () => {
    const parsed = parseCatalogIndex(readJson(join(CATALOG_ROOT, 'catalog.json')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const entry = parsed.index.entries.find(item => item.key === 'product-image-downloader')
    expect(entry, '目录里缺少 product-image-downloader').toBeTruthy()
    if (!entry) return
    expect(entry.dir).toBe('product-image-downloader')
    expect(existsSync(join(PLUGIN_DIR, 'manifest.json'))).toBe(true)
    const validated = validateExtensionManifest(readManifest())
    expect(validated.ok, validated.ok ? '' : validated.message).toBe(true)
  })

  it('只注入抖店商品详情预览页与拼多多商品页，且内容脚本/后台文件真实存在', () => {
    const manifest = readManifest()
    const scripts = manifest.content_scripts || []
    expect(scripts).toHaveLength(1)
    expect(scripts[0].matches).toEqual([
      'https://haohuo.jinritemai.com/ecommerce/trade/detail/*',
      'https://mobile.yangkeduo.com/goods.html*',
      'https://mobile.pinduoduo.com/goods.html*',
      'https://mms.pinduoduo.com/goods/goods_add/*'
    ])
    expect(scripts[0].js).toEqual(['pdd-gallery.js', 'content.js'])
    for (const file of scripts[0].js || []) {
      expect(existsSync(join(PLUGIN_DIR, file)), `缺少 ${file}`).toBe(true)
    }
    const worker = manifest.background && manifest.background.service_worker
    expect(worker).toBe('background.js')
    if (worker) expect(existsSync(join(PLUGIN_DIR, worker))).toBe(true)
  })

  it('不申请 downloads（应用硬阻断、Electron 也未实现），走页面 <a download>', () => {
    const manifest = readManifest()
    const permissions: string[] = [
      ...(manifest.permissions || []),
      ...(manifest.optional_permissions || [])
    ]
    expect(permissions).not.toContain('downloads')
    const content = readFileSync(join(PLUGIN_DIR, 'content.js'), 'utf8')
    const background = readFileSync(join(PLUGIN_DIR, 'background.js'), 'utf8')
    expect(content).not.toMatch(/chrome\.downloads\s*\./)
    expect(background).not.toMatch(/chrome\.downloads\s*\./)
    expect(content).toContain('anchor.download')
    expect(background).toContain('IMGDL_FETCH')
  })

  it('识别规则钉住实测页面结构（改版时必须同步改这里）', () => {
    const content = readFileSync(join(PLUGIN_DIR, 'content.js'), 'utf8')
    expect(content).toContain('head-figure__media-view__content')
    expect(content).toContain('product-big-img-list__every-img')
    expect(content).toContain('title-info__text')
    // ecombdimg 原图模板：去掉 resize 后缀会 400，必须换成 -image.image
    expect(content).toContain('-image.image')
    // 拼多多：rawData 图库 + 商家后台编辑页
    expect(content).toContain('collectPddMobile')
    expect(content).toContain('collectPddMms')
    expect(content).toContain('MaterialModalButton')
  })

  it('拼多多图片 CDN 在 host_permissions 内（内容脚本取原图不受 CORS 影响）', () => {
    const manifest = readManifest()
    const hosts: string[] = (manifest as { host_permissions?: string[] }).host_permissions || []
    expect(hosts).toContain('https://*.pddpic.com/*')
    expect(hosts).toContain('https://*.yangkeduo.com/*')
    expect(hosts).toContain('https://*.pinduoduo.com/*')
  })

  it('批量触发下载做了节流（Chromium 单页短时间连续下载约 10 个会静默丢）', () => {
    const content = readFileSync(join(PLUGIN_DIR, 'content.js'), 'utf8')
    expect(content).toContain('enqueueDownload')
    expect(content).toMatch(/burstCount\s*>=\s*8/)
  })

  it('选择状态按「分组 + URL」作键（同一张图同时出现在主图和详情时不能联动/少算）', () => {
    const content = readFileSync(join(PLUGIN_DIR, 'content.js'), 'utf8')
    expect(content).toContain('function itemKey(item)')
    expect(content).toContain('data-key=')
    expect(content).not.toMatch(/state\.selection\.add\(item\.url\)/)
  })

  it('悬停缩略图在面板左侧显示大图预览（原图，不接收鼠标事件）', () => {
    const content = readFileSync(join(PLUGIN_DIR, 'content.js'), 'utf8')
    expect(content).toContain('hover-preview')
    expect(content).toContain('pointerover')
    expect(content).toContain('pointerout')
    expect(content).toMatch(/preview\.hidden\s*=\s*false/)
    expect(content).toContain('pointer-events: none')
  })
})
