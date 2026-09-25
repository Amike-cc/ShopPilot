/**
 * 工作台 store 的列表筛选（平台 / 搜索 / 分组）。
 *
 * 回归点：「其他」chip 用的是哨兵值 `__other__`（表示"不在内置平台目录里的自定义平台"），
 * 它**不能**拿去和 `s.platform` 比相等——那样点「其他」永远是空列表（真机上表现为
 * "有这个筛选按钮，点了却说没有匹配的店铺"）。这里把哨兵值与真实平台名两种口径都锁住。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore, OTHER_PLATFORM_FILTER } from '../../apps/desktop/src/renderer/src/stores/workspace'

function storeRow(id: string, name: string, platform: string, groupName: string | null = null) {
  return {
    id, name, platform, adminUrl: 'https://example.com', status: 'offline',
    avatarColor: '#3B82F6', sortOrder: 0, groupName, tags: [], lastActiveAt: null
  }
}

describe('工作台店铺筛选', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('内置平台按名字精确筛选', () => {
    const ws = useWorkspaceStore()
    ws.stores = [
      storeRow('s1', '甲', '拼多多'),
      storeRow('s2', '乙', '快手小店'),
      storeRow('s3', '丙', '拼多多')
    ] as any
    ws.filterPlatform = '拼多多'
    expect(ws.filteredStores.map(s => s.id)).toEqual(['s1', 's3'])
  })

  it('「其他」筛出内置目录之外的自定义平台', () => {
    const ws = useWorkspaceStore()
    ws.stores = [
      storeRow('s1', '甲', '拼多多'),
      storeRow('s2', '跨境店', '淘宝'),
      storeRow('s3', '海外店', 'Shopee')
    ] as any
    ws.filterPlatform = OTHER_PLATFORM_FILTER
    expect(ws.filteredStores.map(s => s.id)).toEqual(['s2', 's3'])
  })

  it('「其他」与搜索叠加时只保留命中的自定义平台店铺', () => {
    const ws = useWorkspaceStore()
    ws.stores = [
      storeRow('s1', '甲', '拼多多'),
      storeRow('s2', '跨境店', '淘宝'),
      storeRow('s3', '海外店', 'Shopee')
    ] as any
    ws.filterPlatform = OTHER_PLATFORM_FILTER
    ws.search = '海外'
    expect(ws.filteredStores.map(s => s.id)).toEqual(['s3'])
  })

  it('平台计数按搜索后的结果统计（与界面 chip 上的数字一致）', () => {
    const ws = useWorkspaceStore()
    ws.stores = [
      storeRow('s1', '甲', '拼多多'),
      storeRow('s2', '乙', '拼多多'),
      storeRow('s3', '丙', '淘宝')
    ] as any
    ws.search = '甲'
    expect(ws.platformCounts).toEqual({ 拼多多: 1 })
  })
})
