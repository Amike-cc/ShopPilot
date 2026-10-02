import { describe, expect, it } from 'vitest'
import {
  MEDIA_QUEUE_LIMITS,
  MEDIA_RETENTION,
  decideOrphans,
  orphanCleanupSummary,
  planMediaQueue,
  retryDelayMs,
  type MediaQueueCandidate
} from '../../packages/shared/src/product-media-queue-rules'

function candidate(overrides: Partial<MediaQueueCandidate> = {}): MediaQueueCandidate {
  return {
    productId: 'p1', mediaId: 'm1', role: 'cover', state: 'pending',
    remoteUrl: 'https://a/1.jpg', attempts: 0, sortOrder: 0,
    ...overrides
  }
}

describe('图片队列：排序与上限', () => {
  it('**主图优先**（主图决定能不能发，先把 blocker 解掉最有价值）', () => {
    const { items } = planMediaQueue({
      candidates: [
        candidate({ mediaId: 'g1', role: 'gallery', sortOrder: 0 }),
        candidate({ mediaId: 'c1', role: 'cover', sortOrder: 5 }),
        candidate({ mediaId: 'd1', role: 'detail', sortOrder: 0 }),
        candidate({ mediaId: 's1', role: 'sku', sortOrder: 0 })
      ]
    })
    expect(items.map(item => item.mediaId)).toEqual(['c1', 's1', 'g1', 'd1'])
  })

  it('已本地化的不再入队（只计数跳过）', () => {
    const { items, skipped, summary } = planMediaQueue({
      candidates: [candidate({ mediaId: 'a', state: 'localized' }), candidate({ mediaId: 'b' })]
    })
    expect(items.map(item => item.mediaId)).toEqual(['b'])
    expect(skipped).toBe(1)
    expect(summary).toContain('跳过 1 张')
  })

  it('受上限限制时如实说明"还有多少张下次再跑"', () => {
    const many = Array.from({ length: 5 }, (_, i) => candidate({ mediaId: `m${i}` }))
    const { items, summary } = planMediaQueue({ candidates: many, maxItems: 2 })
    expect(items).toHaveLength(2)
    expect(summary).toContain('上限 2 张')
    expect(summary).toContain('还有 3 张下次再跑')
  })

  it('默认上限是 200 张', () => {
    expect(MEDIA_QUEUE_LIMITS.maxItemsPerRun).toBe(200)
  })
})

describe('图片队列：**不可重试的失败不要反复重试**', () => {
  it('被安全规则拒绝（blocked）→ 不再入队下载，并说清"重试结果相同"', () => {
    const { items } = planMediaQueue({ candidates: [candidate({ state: 'blocked' })] })
    expect(items[0].shouldAttempt).toBe(false)
    expect(items[0].reason).toContain('重试结果相同')
  })

  it('没有图片地址 → 不入队（无从下载），如实说明', () => {
    const { items } = planMediaQueue({ candidates: [candidate({ remoteUrl: null })] })
    expect(items[0].shouldAttempt).toBe(false)
    expect(items[0].reason).toContain('没有图片地址')
  })

  it('失败次数超过上限 → 不再自动重试（避免拖慢队列、刷满日志）', () => {
    const { items } = planMediaQueue({ candidates: [candidate({ state: 'failed', attempts: 3 })], maxRetries: 2 })
    expect(items[0].shouldAttempt).toBe(false)
    expect(items[0].reason).toContain('不再自动重试')
  })

  it('失败次数还没到上限 → 继续试（网络抖动这类值得重试）', () => {
    const { items } = planMediaQueue({ candidates: [candidate({ state: 'failed', attempts: 1 })], maxRetries: 2 })
    expect(items[0].shouldAttempt).toBe(true)
  })

  it('退避是 2 的幂（1.5s → 3s → 6s），不是固定间隔', () => {
    expect(retryDelayMs(1)).toBe(1500)
    expect(retryDelayMs(2)).toBe(3000)
    expect(retryDelayMs(3)).toBe(6000)
  })
})

describe('保留策略：孤儿判定', () => {
  const now = 1_000_000_000_000
  const day = 24 * 60 * 60 * 1000

  it('**表里还在引用**的文件一律不删（有商品在用它）', () => {
    const decision = decideOrphans({
      files: [{ relativePath: 'aa/x.webp', bytes: 100, modifiedAt: now - 40 * day }],
      referencedPaths: new Set(['aa/x.webp']),
      now
    })
    expect(decision.orphans).toHaveLength(0)
    expect(decision.keepCount).toBe(1)
  })

  it('不在表里但**还在宽限期内**的文件不删（刚写盘还没入库的窗口）', () => {
    const decision = decideOrphans({
      files: [{ relativePath: 'bb/y.webp', bytes: 200, modifiedAt: now - 60_000 }],   // 1 分钟前
      referencedPaths: new Set(),
      now
    })
    expect(decision.orphans).toHaveLength(0)
    expect(decision.keepCount).toBe(1)
  })

  it('不在表里 + 超过宽限期 → 判为孤儿，并说清判据', () => {
    const decision = decideOrphans({
      files: [{ relativePath: 'cc/z.webp', bytes: 300, modifiedAt: now - 3 * day }],
      referencedPaths: new Set(),
      now
    })
    expect(decision.orphans).toHaveLength(1)
    expect(decision.orphans[0].reason).toContain('不在商品媒体表里')
    expect(decision.orphanBytes).toBe(300)
  })

  it('宽限期默认 24 小时；已删商品的保留期是 30 天', () => {
    expect(MEDIA_RETENTION.orphanGraceMs).toBe(24 * 60 * 60 * 1000)
    expect(MEDIA_RETENTION.keepAfterProductDeletedMs).toBe(30 * day)
  })
})

describe('清理确认话术', () => {
  it('没有孤儿时明确说"本地图片都在用"（而不是"0 个文件"）', () => {
    expect(orphanCleanupSummary({ orphans: [], orphanBytes: 0 })).toContain('都在用')
  })

  it('有孤儿时说清"将删除 N 个文件、共多少 MB"', () => {
    const summary = orphanCleanupSummary({
      orphans: [{ relativePath: 'a', bytes: 1024 * 1024, reason: '' }, { relativePath: 'b', bytes: 1024 * 1024, reason: '' }],
      orphanBytes: 2 * 1024 * 1024
    })
    expect(summary).toContain('将删除 2 个文件')
    expect(summary).toContain('2.00 MB')
  })
})
