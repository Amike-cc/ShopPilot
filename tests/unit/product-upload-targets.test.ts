import { describe, expect, it } from 'vitest'
import { buildUploadTargetOptions } from '../../apps/desktop/src/renderer/src/features/products/product-upload-targets'

describe('跨店上传目标计算', () => {
  const stores = [
    { id: 'store-a', status: 'online', name: 'A' },
    { id: 'store-b', status: 'online', name: 'B' },
    { id: 'store-offline', status: 'offline', name: '离线店' }
  ]

  it('部分商品已挂载时仍保留目标店铺，并标出已存在数量', () => {
    const result = buildUploadTargetOptions(stores, [
      { sourceStoreIds: ['store-a'] },
      { sourceStoreIds: [] }
    ])

    expect(result).toEqual([
      expect.objectContaining({ id: 'store-a', existingCount: 1, selectedCount: 2, canReceive: true }),
      expect.objectContaining({ id: 'store-b', existingCount: 0, selectedCount: 2, canReceive: true })
    ])
    expect(result.some(row => row.id === 'store-offline')).toBe(false)
  })

  it('全部商品都已挂载时禁用该店铺，避免建立必然失败的批次', () => {
    const result = buildUploadTargetOptions(stores, [
      { sourceStoreIds: ['store-a'] },
      { sourceStoreIds: ['store-a', 'store-b'] }
    ])

    expect(result.find(row => row.id === 'store-a')).toMatchObject({ existingCount: 2, canReceive: false })
    expect(result.find(row => row.id === 'store-b')).toMatchObject({ existingCount: 1, canReceive: true })
  })

  it('没有本地选择时只返回在线店铺，并允许后续由页面做空商品校验', () => {
    const result = buildUploadTargetOptions(stores, [])
    expect(result.map(row => row.id)).toEqual(['store-a', 'store-b'])
    expect(result.every(row => row.canReceive)).toBe(true)
  })
})
