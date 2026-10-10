import { describe, expect, it } from 'vitest'
import {
  browserClearDataSchema,
  browserOpenSchema,
  browserTabReorderSchema,
  browserViewportSchema
} from '../../packages/shared/src/schemas/browser'

describe('浏览器 IPC 输入边界', () => {
  it('拒绝缺失店铺、未知字段和错误 display 类型', () => {
    expect(browserOpenSchema.safeParse({}).success).toBe(false)
    expect(browserOpenSchema.safeParse({ storeId: 'store-1', display: 'yes' }).success).toBe(false)
    expect(browserOpenSchema.safeParse({ storeId: 'store-1', extra: true }).success).toBe(false)
    expect(browserOpenSchema.parse({ storeId: ' store-1 ' })).toEqual({ storeId: 'store-1' })
  })

  it('拒绝重复标签页、重复清理类型和超范围视口', () => {
    expect(browserTabReorderSchema.safeParse({ storeId: 's', orderedTabIds: ['a', 'a'] }).success).toBe(false)
    expect(browserClearDataSchema.safeParse({ storeId: 's', types: ['cookies', 'cookies'] }).success).toBe(false)
    expect(browserClearDataSchema.safeParse({ storeId: 's', types: ['unknown'] }).success).toBe(false)
    expect(browserViewportSchema.safeParse({ x: 0, y: 0, width: 16385, height: 1 }).success).toBe(false)
    expect(browserViewportSchema.safeParse({ x: 0, y: 0, width: Number.NaN, height: 1 }).success).toBe(false)
  })
})
