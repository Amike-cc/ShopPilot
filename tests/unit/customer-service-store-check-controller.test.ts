import { describe, expect, it, vi } from 'vitest'
import { createStoreScopedCheckController, type StoreCheckResult } from '../../apps/desktop/src/renderer/src/features/customer-service/store-scoped-check-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('客服状态检查按店铺隔离', () => {
  it('允许不同店铺并行检查、阻止同店重复请求，并把错误留在来源店铺', async () => {
    const storeA = deferred<StoreCheckResult<string>>()
    const storeB = deferred<StoreCheckResult<string>>()
    const request = vi.fn((storeId: string) => storeId === 'store-a' ? storeA.promise : storeB.promise)
    const successes = new Map<string, string>()
    const controller = createStoreScopedCheckController(request, (storeId, data) => successes.set(storeId, data))

    const checkingA = controller.check('store-a')
    const duplicateA = controller.check('store-a')
    const checkingB = controller.check('store-b')

    expect(request).toHaveBeenCalledTimes(2)
    expect([...controller.checkingStoreIds].sort()).toEqual(['store-a', 'store-b'])

    storeA.resolve({ ok: false, error: { message: 'A 店检查失败' } })
    storeB.resolve({ ok: true, data: 'B 店检查结果' })
    await Promise.all([checkingA, duplicateA, checkingB])

    expect(controller.errors.get('store-a')).toBe('A 店检查失败')
    expect(controller.errors.has('store-b')).toBe(false)
    expect(successes.get('store-b')).toBe('B 店检查结果')
    expect(controller.checkingStoreIds.size).toBe(0)
  })
})
