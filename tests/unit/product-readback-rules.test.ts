import { describe, expect, it } from 'vitest'
import {
  compareReadbackFields,
  completionChecklist,
  mergeRequirements,
  type PlatformRequirement
} from '../../packages/shared/src/product-readback-rules'

describe('回读对比：三类建议 + 两种无需处理的观察', () => {
  it('本地没有、平台上用户填了 → suggest_default（建议存为默认值，需确认）', () => {
    const result = compareReadbackFields({
      local: { title: '本地标题' },
      platformValues: { title: '本地标题', brand: '无品牌' }
    })
    const brand = result.suggestions.find(item => item.field === 'brand')!
    expect(brand.kind).toBe('suggest_default')
    expect(brand.platformValue).toBe('无品牌')
    expect(brand.note).toContain('下次发布自动填')
    expect(result.counts.suggestDefault).toBe(1)
  })

  it('本地有、用户在平台上改了 → suggest_writeback（摆两边让用户选，**不自动改**）', () => {
    const result = compareReadbackFields({
      local: { title: '本地标题', price: '6.90' },
      platformValues: { title: '本地标题', price: '7.90' }
    })
    const price = result.suggestions.find(item => item.field === 'price')!
    expect(price.kind).toBe('suggest_writeback')
    expect(price.localValue).toBe('6.90')
    expect(price.platformValue).toBe('7.90')
    expect(price.note).toContain('要不要把本地改成平台那一版')
  })

  it('两边一致 → same（无需处理，但也要摆出来让人看得见）', () => {
    const result = compareReadbackFields({ local: { title: '一样' }, platformValues: { title: '一样' } })
    expect(result.suggestions[0].kind).toBe('same')
    expect(result.actionable).toHaveLength(0)
  })

  it('只有本地有 → only_local（平台上这一项是空的，记进必填缺失清单）', () => {
    const result = compareReadbackFields({ local: { category: '家居>沙发' }, platformValues: {} })
    const category = result.suggestions.find(item => item.field === 'category')!
    expect(category.kind).toBe('only_local')
    expect(category.note).toContain('必填')
  })

  it('空白归一化：只差空格/换行不算"改了"（平台常做归一化）', () => {
    const result = compareReadbackFields({
      local: { title: '  真皮  沙发 ' },
      platformValues: { title: '真皮 沙发' }
    })
    expect(result.suggestions[0].kind).toBe('same')
  })

  it('空字符串与 null 一样按"没有值"处理（不产生假的 suggest_writeback）', () => {
    const result = compareReadbackFields({ local: { brand: '' }, platformValues: { brand: null } })
    expect(result.suggestions[0].kind).toBe('same')
    expect(result.actionable).toHaveLength(0)
  })

  it('可处理项排在前面、且能只取需要用户决定的那部分', () => {
    const result = compareReadbackFields({
      local: { title: '一样', price: '6.90', category: '家居' },
      platformValues: { title: '一样', price: '7.90' }
    })
    expect(result.actionable.map(item => item.field).sort()).toEqual(['category', 'price'])
    expect(result.counts).toEqual({ suggestDefault: 0, suggestWriteback: 1, same: 1, onlyLocal: 1 })
  })
})

describe('平台必填清单：跨次记住，不因为一次没看到就忘掉', () => {
  const req = (field: string, observedAt: number, platform = '微信小店'): PlatformRequirement =>
    ({ platform, field, label: field, observedAt })

  it('同一 (平台,字段) 只留一条，observedAt 取最新', () => {
    const merged = mergeRequirements([req('category', 100)], [req('category', 200)])
    expect(merged).toHaveLength(1)
    expect(merged[0].observedAt).toBe(200)
  })

  it('**以前记下、这次没观察到的不要删**（删掉会让提示悄悄失效）', () => {
    const merged = mergeRequirements([req('category', 100), req('brand', 100)], [req('category', 200)])
    expect(merged.map(item => item.field).sort()).toEqual(['brand', 'category'])
    expect(merged.find(item => item.field === 'brand')!.observedAt).toBe(100)   // 保留旧的观察时间
  })

  it('不同平台互不影响', () => {
    const merged = mergeRequirements([req('category', 100, '微信小店')], [req('category', 100, '抖店')])
    expect(merged).toHaveLength(2)
  })
})

describe('本地补全清单：平台必填 + 本地没有', () => {
  it('只列出"该平台必填、本地还没有"的字段', () => {
    const requirements: PlatformRequirement[] = [
      { platform: '微信小店', field: 'category', label: '类目', observedAt: 1 },
      { platform: '微信小店', field: 'brand', label: '品牌', observedAt: 1 },
      { platform: '抖店', field: 'category', label: '类目', observedAt: 1 }
    ]
    const list = completionChecklist({ requirements, platform: '微信小店', local: { brand: '无品牌' } })
    expect(list).toHaveLength(1)
    expect(list[0].field).toBe('category')
    expect(list[0].reason).toContain('平台必填')
  })

  it('空白值按"没有"处理（不会被当成已填）', () => {
    const requirements: PlatformRequirement[] = [{ platform: '微信小店', field: 'brand', label: '品牌', observedAt: 1 }]
    expect(completionChecklist({ requirements, platform: '微信小店', local: { brand: '   ' } })).toHaveLength(1)
  })
})
