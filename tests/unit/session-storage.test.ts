import { describe, expect, it } from 'vitest'
import {
  SESSION_STORAGE_LIMITS,
  candidateStorageOrigins,
  normalizeStorageOrigin,
  sanitizeStorageEntries
} from '@shared/session-storage'

describe('origin 规范化', () => {
  it('只留 scheme://host[:port]，丢掉路径/查询/末尾斜杠', () => {
    expect(normalizeStorageOrigin('https://fxg.jinritemai.com/ffa/mshop/trade?x=1#h')).toBe('https://fxg.jinritemai.com')
    expect(normalizeStorageOrigin('http://127.0.0.1:8080/a/b')).toBe('http://127.0.0.1:8080')
    expect(normalizeStorageOrigin('https://EXAMPLE.com/')).toBe('https://example.com')
  })

  it('非 http(s) 与带凭据的 URL 一律拒绝（不能把 file/data 的存储写进包）', () => {
    for (const bad of ['file:///C:/secret', 'data:text/html,hi', 'javascript:alert(1)', 'about:blank', 'chrome://settings', '']) {
      expect(normalizeStorageOrigin(bad)).toBeNull()
    }
    expect(normalizeStorageOrigin('https://user:pass@example.com/')).toBeNull()
    expect(normalizeStorageOrigin(null)).toBeNull()
    expect(normalizeStorageOrigin(123)).toBeNull()
  })
})

describe('采集结果限额', () => {
  it('origin 去重，重复的只保留第一份', () => {
    const out = sanitizeStorageEntries([
      { origin: 'https://a.com', items: [{ name: 'k', value: '1' }] },
      { origin: 'https://a.com/', items: [{ name: 'k2', value: '2' }] }
    ])
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0].items.map(item => item.name)).toEqual(['k'])
    expect(out.items).toBe(1)
  })

  it('兼容 [name,value][] 与对象映射两种形状', () => {
    const asPairs = sanitizeStorageEntries([{ origin: 'https://a.com', items: [['token', 't1']] }])
    const asObject = sanitizeStorageEntries([{ origin: 'https://a.com', items: { token: 't1' } }])
    expect(asPairs.entries).toEqual(asObject.entries)
    expect(asPairs.items).toBe(1)
  })

  it('单个值超过上限整条丢弃，并计入 skippedItems', () => {
    const big = 'x'.repeat(SESSION_STORAGE_LIMITS.maxValueChars + 1)
    const out = sanitizeStorageEntries([{ origin: 'https://a.com', items: [{ name: 'huge', value: big }, { name: 'ok', value: '1' }] }])
    expect(out.entries[0].items.map(item => item.name)).toEqual(['ok'])
    expect(out.skippedItems).toBe(1)
  })

  it('单站点条数超过上限时截断并如实计数', () => {
    const items = Array.from({ length: SESSION_STORAGE_LIMITS.maxItemsPerOrigin + 5 }, (_, i) => ({ name: `k${i}`, value: 'v' }))
    const out = sanitizeStorageEntries([{ origin: 'https://a.com', items }])
    expect(out.entries[0].items).toHaveLength(SESSION_STORAGE_LIMITS.maxItemsPerOrigin)
    expect(out.skippedItems).toBe(5)
  })

  it('站点数超过上限时整站丢弃，与"条目超限"分开计数', () => {
    const rows = Array.from({ length: SESSION_STORAGE_LIMITS.maxOrigins + 2 }, (_, i) => ({
      origin: `https://s${i}.com`, items: [{ name: 'k', value: 'v' }]
    }))
    const out = sanitizeStorageEntries(rows)
    expect(out.entries).toHaveLength(SESSION_STORAGE_LIMITS.maxOrigins)
    expect(out.skippedOrigins).toBe(2)
    expect(out.skippedItems).toBe(0)
  })

  it('整包总量超限时后续站点被裁剪，totalChars 不越界', () => {
    // 每站 ~400k 字符，8 站 ~3.2M，超过 3M 的总预算
    const value = 'y'.repeat(400_000)
    const rows = Array.from({ length: 8 }, (_, i) => ({ origin: `https://s${i}.com`, items: [{ name: 'k', value }] }))
    const out = sanitizeStorageEntries(rows)
    expect(out.chars).toBeLessThanOrEqual(SESSION_STORAGE_LIMITS.maxTotalChars)
    expect(out.entries.length).toBeLessThan(8)
    expect(out.skippedItems).toBeGreaterThan(0)
  })

  it('空输入返回空结果（不是抛错，也不是一条空记录）', () => {
    expect(sanitizeStorageEntries(undefined).entries).toEqual([])
    expect(sanitizeStorageEntries('garbage').entries).toEqual([])
    expect(sanitizeStorageEntries([{ origin: 'not-a-url', items: [{ name: 'a', value: 'b' }] }]).entries).toEqual([])
  })
})

describe('导出候选 origin', () => {
  it('店铺地址 + 平台入口去重后按顺序保留', () => {
    const out = candidateStorageOrigins({
      adminUrl: 'https://fxg.jinritemai.com/ffa/mshop',
      routeUrls: ['https://fxg.jinritemai.com/ffa/mshop/other', 'https://buyin.jinritemai.com/dashboard'],
      cookieDomains: []
    })
    expect(out).toEqual(['https://fxg.jinritemai.com', 'https://buyin.jinritemai.com'])
  })

  it('Cookie 主机只收与后台同后缀的，第三方域名不碰', () => {
    const out = candidateStorageOrigins({
      adminUrl: 'https://fxg.jinritemai.com/ffa/mshop',
      routeUrls: [],
      cookieDomains: ['.jinritemai.com', 'fxg.jinritemai.com', 'cdn.example.net', 'evil-jinritemai.com']
    })
    expect(out).toContain('https://jinritemai.com')
    expect(out).toContain('https://fxg.jinritemai.com')
    expect(out).not.toContain('https://cdn.example.net')
    // 反向拼接的仿冒域不能因为"包含平台名"就被放进来：判据是 adminHost.endsWith(host)，
    // 比后台域名更长的串天然不成立
    expect(out).not.toContain('https://evil-jinritemai.com')
  })

  it('按 max 截断，默认不超过 8 个站点', () => {
    const out = candidateStorageOrigins({
      adminUrl: 'https://a.com',
      routeUrls: Array.from({ length: 12 }, (_, i) => `https://r${i}.a.com`),
      cookieDomains: []
    })
    expect(out.length).toBeLessThanOrEqual(SESSION_STORAGE_LIMITS.maxOrigins)
  })
})
