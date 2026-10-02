import { describe, expect, it } from 'vitest'
import {
  PLATFORM_TITLE_LIMITS,
  draftFromPlatformProduct,
  hasBlockingIssue,
  localProductDraftHash,
  productDraftIssues,
  type LocalProductDraft
} from '../../packages/shared/src/product-draft'

/** 一份"能发出去"的基线草稿：后面每个用例只改一处，断言那一处的判定。 */
function goodDraft(overrides: Partial<LocalProductDraft> = {}): LocalProductDraft {
  return {
    title: '儿童加厚款暖暖套装',
    subtitle: null,
    description: null,
    brand: null,
    localCategory: null,
    tags: [],
    variants: [{ spec: [{ name: '颜色', value: '红' }], priceMinor: 2990, stock: 100 }],
    media: [{ role: 'cover', state: 'localized', remoteUrl: 'https://mmec.wxqcloud.qq.com.cn/a.jpg' }],
    ...overrides
  }
}

describe('本地商品校验：分级要准，且只写有实测支撑的平台规则', () => {
  it('基线草稿没有任何问题', () => {
    expect(productDraftIssues(goodDraft())).toEqual([])
    expect(hasBlockingIssue(productDraftIssues(goodDraft()))).toBe(false)
  })

  it('标题为空 / 没有主图 / 没有规格 / 价格非法 → blocker', () => {
    expect(productDraftIssues(goodDraft({ title: '   ' }))[0]).toMatchObject({ level: 'blocker', field: 'title' })
    expect(productDraftIssues(goodDraft({ media: [] }))[0]).toMatchObject({ level: 'blocker', field: 'media' })
    expect(productDraftIssues(goodDraft({ variants: [] }))[0]).toMatchObject({ level: 'blocker', field: 'variants' })
    const noPrice = productDraftIssues(goodDraft({ variants: [{ spec: [], priceMinor: null, stock: 1 }] }))
    expect(noPrice[0]).toMatchObject({ level: 'blocker', field: 'price' })
    const zeroPrice = productDraftIssues(goodDraft({ variants: [{ spec: [], priceMinor: 0, stock: 1 }] }))
    expect(zeroPrice[0].message).toContain('必须大于 0')
    const negativeStock = productDraftIssues(goodDraft({ variants: [{ spec: [], priceMinor: 100, stock: -1 }] }))
    expect(negativeStock[0]).toMatchObject({ level: 'blocker', field: 'stock' })
  })

  it('标题超长只在**有实测上限**的平台上报 warning（微信 60 字），没实测的平台不猜', () => {
    expect(PLATFORM_TITLE_LIMITS['微信小店']).toBe(60)
    const long = '一'.repeat(61)
    const wechat = productDraftIssues(goodDraft({ title: long }), { platform: '微信小店' })
    expect(wechat[0]).toMatchObject({ level: 'warning', field: 'title' })
    expect(wechat[0].message).toContain('60 字上限')

    // 抖店/拼多多/快手：没有实测到上限 → 不给上限判定（不猜）
    for (const platform of ['抖店', '拼多多', '快手小店']) {
      expect(productDraftIssues(goodDraft({ title: long }), { platform })).toEqual([])
    }
    // 刚好 60 字不算超
    expect(productDraftIssues(goodDraft({ title: '一'.repeat(60) }), { platform: '微信小店' })).toEqual([])
  })

  it('图片没本地化是 warning（能发但会依赖平台链接），不是 blocker', () => {
    const issues = productDraftIssues(goodDraft({
      media: [
        { role: 'cover', state: 'pending', remoteUrl: 'https://a/1.jpg' },
        { role: 'gallery', state: 'failed', remoteUrl: 'https://a/2.jpg' }
      ]
    }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'warning', field: 'media' })
    expect(issues[0].message).toContain('2 张图片还没本地化')
  })

  it('本地价与平台价不一致 → info（只提示，不阻断）', () => {
    const issues = productDraftIssues(goodDraft(), { platformPriceMinor: 3990 })
    expect(issues[0]).toMatchObject({ level: 'info', field: 'price' })
    expect(issues[0].message).toContain('不一致')
    expect(hasBlockingIssue(issues)).toBe(false)
  })

  it('多规格里只要有一个非法就报出来，且指明是哪个规格', () => {
    const issues = productDraftIssues(goodDraft({
      variants: [
        { spec: [{ name: '颜色', value: '红' }], priceMinor: 1000, stock: 1 },
        { spec: [{ name: '颜色', value: '蓝' }], priceMinor: null, stock: 1 }
      ]
    }))
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('颜色蓝')
  })
})

describe('草稿指纹：决定"改没改"，也是发布幂等键的组成部分', () => {
  it('同内容同指纹、与键顺序无关', () => {
    expect(localProductDraftHash(goodDraft())).toBe(localProductDraftHash(goodDraft()))
    expect(localProductDraftHash(goodDraft({ tags: ['a', 'b'] }))).toBe(localProductDraftHash(goodDraft({ tags: ['b', 'a'] })))
  })

  it('标题/价格/库存/规格任一变化都要变', () => {
    const base = localProductDraftHash(goodDraft())
    expect(localProductDraftHash(goodDraft({ title: '改了标题' }))).not.toBe(base)
    expect(localProductDraftHash(goodDraft({ variants: [{ spec: [], priceMinor: 2991, stock: 100 }] }))).not.toBe(base)
    expect(localProductDraftHash(goodDraft({ variants: [{ spec: [], priceMinor: 2990, stock: 101 }] }))).not.toBe(base)
  })

  it('图片**本地化状态**不参与指纹（同一张图从"未本地化"变"已本地化"不算内容变化）', () => {
    const pending = localProductDraftHash(goodDraft({ media: [{ role: 'cover', state: 'pending', remoteUrl: 'https://a/1.jpg' }] }))
    const localized = localProductDraftHash(goodDraft({ media: [{ role: 'cover', state: 'localized', remoteUrl: 'https://a/1.jpg' }] }))
    expect(pending).toBe(localized)
    // 但换一张图必须变
    const other = localProductDraftHash(goodDraft({ media: [{ role: 'cover', state: 'localized', remoteUrl: 'https://a/2.jpg' }] }))
    expect(other).not.toBe(localized)
  })

  it('图片顺序变化要变（主图换了就是不同的商品展示）', () => {
    const a = localProductDraftHash(goodDraft({ media: [
      { role: 'cover', remoteUrl: 'https://a/1.jpg' }, { role: 'gallery', remoteUrl: 'https://a/2.jpg' }
    ] }))
    const b = localProductDraftHash(goodDraft({ media: [
      { role: 'cover', remoteUrl: 'https://a/2.jpg' }, { role: 'gallery', remoteUrl: 'https://a/1.jpg' }
    ] }))
    expect(a).not.toBe(b)
  })
})

describe('从平台商品生成本地草稿初值', () => {
  it('列表页拿不到 SKU 时建一个单规格占位（而不是留空让用户懵）', () => {
    const draft = draftFromPlatformProduct({ title: '密封胶泥', priceMinor: 980, stock: 19999877, imageUrls: ['https://a/1.jpg'] })
    expect(draft.variants).toEqual([{ spec: [], priceMinor: 980, stock: 19999877 }])
    expect(draft.media[0]).toMatchObject({ role: 'cover', state: 'pending' })
  })

  it('有 SKU 时按 SKU 展开，第一张图当主图', () => {
    const draft = draftFromPlatformProduct({
      title: 'T 恤', priceMinor: 1000, stock: 5,
      imageUrls: ['https://a/1.jpg', 'https://a/2.jpg'],
      skus: [
        { spec: [{ name: '颜色', value: '红' }], priceMinor: 1000, stock: 3 },
        { spec: [{ name: '颜色', value: '蓝' }], priceMinor: 1200, stock: 2 }
      ]
    })
    expect(draft.variants).toHaveLength(2)
    expect(draft.media.map(m => m.role)).toEqual(['cover', 'gallery'])
  })

  it('生成的草稿是"可保存但还不能发布"的：价格库存来自列表页，规格待补', () => {
    const draft = draftFromPlatformProduct({ title: '密封胶泥', priceMinor: 980, stock: 10, imageUrls: ['https://a/1.jpg'] })
    const issues = productDraftIssues(draft)
    expect(hasBlockingIssue(issues)).toBe(false)   // 有标题/主图/规格/价格 → 不是 blocker
  })
})
