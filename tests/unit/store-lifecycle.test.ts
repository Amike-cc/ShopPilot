import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORE_COLD_SLEEP_AFTER_MS,
  StoreLifecycleRegistry
} from '../../apps/desktop/src/main/browser/store-lifecycle'

describe('店铺浏览器生命周期策略', () => {
  it('只保留最近一次切换的上一家店铺作为温缓存', () => {
    const lifecycle = new StoreLifecycleRegistry()
    lifecycle.used('store_a', 'displayed', 100)
    lifecycle.used('store_b', 'displayed', 200)
    lifecycle.used('store_c', 'displayed', 300)

    expect(lifecycle.getWarmStoreIds('store_c')).toEqual(['store_b'])
    expect(lifecycle.getColdCandidates('store_c', 300 + DEFAULT_STORE_COLD_SLEEP_AFTER_MS)).toEqual(['store_a'])
  })

  it('后台打开的店铺不进入温缓存，空闲后可冷休眠', () => {
    const lifecycle = new StoreLifecycleRegistry()
    lifecycle.used('store_a', 'background', 0)
    lifecycle.used('store_b', 'displayed', 10)

    expect(lifecycle.getWarmStoreIds('store_b')).toEqual([])
    expect(lifecycle.getColdCandidates('store_b', DEFAULT_STORE_COLD_SLEEP_AFTER_MS)).toEqual(['store_a'])
  })

  it('后台使用会刷新冷休眠倒计时，但不改变温缓存排序', () => {
    const lifecycle = new StoreLifecycleRegistry()
    lifecycle.used('store_a', 'displayed', 100)
    lifecycle.used('store_b', 'displayed', 200)
    lifecycle.used('store_a', 'background', 500)

    expect(lifecycle.getWarmStoreIds('store_b')).toEqual(['store_a'])
    expect(lifecycle.getColdCandidates('store_b', 500 + DEFAULT_STORE_COLD_SLEEP_AFTER_MS - 1)).toEqual([])
    expect(lifecycle.getColdCandidates('store_b', 500 + DEFAULT_STORE_COLD_SLEEP_AFTER_MS)).toEqual([])
  })

  it('阻塞店铺不会被列为冷休眠候选，解除阻塞后可再次评估', () => {
    const lifecycle = new StoreLifecycleRegistry()
    lifecycle.used('store_a', 'background', 0)
    const blocked = new Set(['store_a'])

    expect(lifecycle.getColdCandidates('store_b', DEFAULT_STORE_COLD_SLEEP_AFTER_MS, DEFAULT_STORE_COLD_SLEEP_AFTER_MS, blocked)).toEqual([])
    expect(lifecycle.getColdCandidates('store_b', DEFAULT_STORE_COLD_SLEEP_AFTER_MS)).toEqual(['store_a'])
  })

  it('关闭店铺后不再出现在策略记录中', () => {
    const lifecycle = new StoreLifecycleRegistry()
    lifecycle.used('store_a', 'displayed', 100)
    lifecycle.forget('store_a')
    expect(lifecycle.get('store_a')).toBeNull()
    expect(lifecycle.snapshot(200)).toEqual([])
  })
})
