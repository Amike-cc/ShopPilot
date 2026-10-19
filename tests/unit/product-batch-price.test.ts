import { describe, expect, it } from 'vitest'
import { PRODUCT_BATCH_LIMITS, applyBatchPrice, describeBatchPrice } from '../../packages/shared/src/product-batch'

/**
 * v4 重设计 §3.5：批量改价的**纯数学**（测试清单 9.2：百分比/固定额、四舍五入、
 * 最低价保护、null 跳过）。null 进 null 出——"价格未取到"绝不当 0。
 */

describe('applyBatchPrice：批量改价数学', () => {
  it('按百分比：+10% 四舍五入到分', () => {
    expect(applyBatchPrice(12900, { mode: 'percent', value: 10 })).toBe(14190) // 129 × 1.1 = 141.9
    expect(applyBatchPrice(999, { mode: 'percent', value: 10 })).toBe(1099) // 9.99 × 1.1 = 10.989 → 10.99（四舍五入 1099）
  })

  it('按百分比：降价与向下取整', () => {
    expect(applyBatchPrice(10000, { mode: 'percent', value: -10 })).toBe(9000)
    expect(applyBatchPrice(1055, { mode: 'percent', value: -10 })).toBe(950) // 10.55×0.9=9.495 → 950（round）
  })

  it('按固定金额：加减以元为单位转分', () => {
    expect(applyBatchPrice(12900, { mode: 'fixed', value: -5 })).toBe(12400)
    expect(applyBatchPrice(12900, { mode: 'fixed', value: 0.5 })).toBe(12950)
  })

  it('最低价保护：结果不低于下限（默认 1 分）', () => {
    expect(applyBatchPrice(50, { mode: 'percent', value: -99 })).toBe(1)
    expect(applyBatchPrice(50, { mode: 'percent', value: -99, floorMinor: 100 })).toBe(100) // 自定义下限 1 元
    // 保护触发时 diff 要如实标注
    expect(describeBatchPrice(40, 1, { mode: 'percent', value: -99 })).toContain('最低价保护') // 40×1% = 0.4 分 < 1 分下限
    expect(describeBatchPrice(12900, 14190, { mode: 'percent', value: 10 })).not.toContain('最低价保护')
  })

  it('null 进 null 出：价格未取到的变体跳过（绝不当 0）', () => {
    expect(applyBatchPrice(null, { mode: 'percent', value: 10 })).toBeNull()
    expect(applyBatchPrice(null, { mode: 'fixed', value: 5, floorMinor: 1 })).toBeNull()
  })

  it('上限常量与 §3.5 表格一致', () => {
    expect(PRODUCT_BATCH_LIMITS.price).toBe(200)
    expect(PRODUCT_BATCH_LIMITS.tags).toBe(500)
    expect(PRODUCT_BATCH_LIMITS.archive).toBe(500)
    expect(PRODUCT_BATCH_LIMITS.delete).toBe(100)
    expect(PRODUCT_BATCH_LIMITS.select).toBe(500)
  })
})
