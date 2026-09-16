import { describe, expect, it } from 'vitest'
import { storeCreateSchema, storeReorderSchema, storeUpdateSchema } from '@shared/schemas/store'

describe('store IPC schemas', () => {
  it('provides a safe default admin URL and rejects invalid URLs', () => {
    expect(storeCreateSchema.parse({ name: '店铺', platform: 'douyin' }).adminUrl).toBe('')
    expect(storeCreateSchema.safeParse({ name: '店铺', platform: 'douyin', adminUrl: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('rejects unknown fields and duplicate reorder IDs', () => {
    expect(storeUpdateSchema.safeParse({ storeId: 'store_1', patch: {}, unexpected: true }).success).toBe(false)
    expect(storeReorderSchema.safeParse({ orderedStoreIds: ['store_1', 'store_1'] }).success).toBe(false)
  })
})
