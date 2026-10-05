/**
 * 「取消自动采集、改为手动」的回归测试。
 *
 * 背景（2026-10-04 用户要求）：之前应用会**自己**给店铺建 enabled=1 的计划（每 10 分钟一采），
 * 还有每 3 小时的定时任务（发票采集）——用户在不知情的情况下一直被自动采集。
 * 现在默认关闭：缺省、乱填、读不到都按"手动"算，只有界面明确打开才自动跑。
 */
import { describe, expect, it } from 'vitest'
import { AUTO_COLLECTION_DEFAULT, AUTO_COLLECTION_SETTING, parseAutoCollectionEnabled } from '@shared/constants/collection'

describe('自动采集总开关的解析（fail-closed）', () => {
  it('默认是关的', () => {
    expect(AUTO_COLLECTION_DEFAULT).toBe(false)
    expect(parseAutoCollectionEnabled(undefined)).toBe(false)
    expect(parseAutoCollectionEnabled(null)).toBe(false)
  })

  it('只有明确表示"开"的值才算开', () => {
    for (const value of [true, 1, 'true', 'TRUE', ' true ', '1']) {
      expect(parseAutoCollectionEnabled(value)).toBe(true)
    }
  })

  it('乱填/其它类型一律按关处理（宁可少采，不可偷偷采）', () => {
    for (const value of [false, 0, 'false', 'no', 'yes', '', '  ', '2', {}, [], { enabled: true }]) {
      expect(parseAutoCollectionEnabled(value)).toBe(false)
    }
  })

  it('设置键名固定为 collection.autoEnabled（渲染层与主进程共用）', () => {
    expect(AUTO_COLLECTION_SETTING).toBe('collection.autoEnabled')
  })
})
