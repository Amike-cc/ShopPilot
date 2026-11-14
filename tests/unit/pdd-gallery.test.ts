/**
 * 拼多多图库解析（pdd-gallery.js）契约测试（2026-11-15）。
 *
 * 拼多多手机商品页需要消费者登录，自动化环境里拿不到真实登录态；这里用
 * mobile 站 react_goods bundle 里实测的 gallery 结构（type 1/2/13/6/9）钉住解析规则，
 * 页面交互由 tools/acceptance/product-image-pdd-verify.js 在商家后台真实商品上验收。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface GalleryItem {
  url: string
}
interface ParsedGallery {
  main: GalleryItem[]
  detail: GalleryItem[]
  videoCount: number
  title: string
  source: string
}
interface PddGalleryApi {
  normalizeImageUrl(raw: string, base?: string): string
  extractJsonObject(text: string, start: number): string
  looksLikeGallery(items: unknown[]): boolean
  splitGallery(
    gallery: Array<{ type: string | number; url: string }>,
    base?: string
  ): { main: GalleryItem[]; detail: GalleryItem[]; videoCount: number }
  parseScripts(scripts: string[], base?: string): ParsedGallery | null
}

const ROOT = resolve(__dirname, '../..')
const SOURCE = readFileSync(
  join(ROOT, 'assets', 'browser-extensions', 'product-image-downloader', 'pdd-gallery.js'),
  'utf8'
)
const moduleShim: { exports: Partial<PddGalleryApi> } = { exports: {} }
new Function('module', 'exports', SOURCE)(moduleShim, moduleShim.exports)
const pdd = moduleShim.exports as PddGalleryApi

const BASE = 'https://mobile.yangkeduo.com'

describe('拼多多图片地址与 rawData 解析', () => {
  it('图片处理参数被去掉（imageView2 / imageMogr2），相对地址按手机站补全', () => {
    expect(
      pdd.normalizeImageUrl(
        'https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg?imageView2/2/w/1700/q/85',
        BASE
      )
    ).toBe('https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg')
    expect(
      pdd.normalizeImageUrl(
        'https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg?imageMogr2/quality/90/thumbnail/1300x9999%3E',
        BASE
      )
    ).toBe('https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg')
    expect(pdd.normalizeImageUrl('/mms-material-img/2025-12-31/a.jpeg.a.jpeg?imageView2/2/w/800', BASE)).toBe(
      'https://mobile.yangkeduo.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg'
    )
    expect(pdd.normalizeImageUrl('https://example.com/a.jpg', BASE)).toBe('')
  })

  it('JSON 提取能处理字符串里的花括号和转义', () => {
    const text = 'window.rawData={"store":{"name":"a}b\\"c","gallery":[]},"x":1};'
    const start = text.indexOf('{')
    expect(pdd.extractJsonObject(text, start)).toBe(
      '{"store":{"name":"a}b\\"c","gallery":[]},"x":1}'
    )
  })

  it('gallery 按 type 分组：1/13 主图、2 详情图、6/9 视频只计数', () => {
    const parsed = pdd.splitGallery(
      [
        { type: 1, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg' },
        { type: 13, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/b.jpeg.a.jpeg' },
        { type: 2, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/c.jpeg.a.jpeg' },
        { type: 2, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/d.jpeg.a.jpeg' },
        { type: 2, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/c.jpeg.a.jpeg?imageView2/2/w/800' },
        { type: 6, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/v.mp4' },
        { type: 9, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/d.mp4' }
      ],
      BASE
    )
    expect(parsed.main.map(item => item.url)).toHaveLength(2)
    expect(parsed.detail.map(item => item.url)).toHaveLength(2)
    expect(parsed.videoCount).toBe(2)
  })

  it('从 server-rendered window.rawData 中找出 gallery 与商品标题', () => {
    const rawData = {
      store: {
        data: {
          goods: {
            goods_name: '植绒小灯笼挂饰新年春节喜庆装饰盆景阳台户外挂件教室灯笼布置',
            gallery: [
              { type: 1, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg' },
              { type: 2, url: 'https://img.pddpic.com/mms-material-img/2025-12-31/b.jpeg.a.jpeg?imageMogr2/quality/90' }
            ]
          }
        }
      }
    }
    const parsed = pdd.parseScripts([`window.rawData=${JSON.stringify(rawData)};`], BASE)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.source).toBe('rawData')
    expect(parsed.title).toContain('植绒小灯笼')
    expect(parsed.main[0].url).toBe(
      'https://img.pddpic.com/mms-material-img/2025-12-31/a.jpeg.a.jpeg'
    )
    expect(parsed.detail[0].url).toBe(
      'https://img.pddpic.com/mms-material-img/2025-12-31/b.jpeg.a.jpeg'
    )
  })

  it('没有 rawData / 不是图库数组时返回 null，交给 DOM 兜底', () => {
    expect(pdd.parseScripts(['window.rawData={"store":{"data":{}}};'], BASE)).toBeNull()
    expect(pdd.looksLikeGallery([{ url: 'https://img.pddpic.com/a.jpg' }])).toBe(false)
    expect(pdd.looksLikeGallery([{ type: 2, url: 'https://img.pddpic.com/a.jpg' }])).toBe(true)
  })
})
