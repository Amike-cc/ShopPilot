import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shopSessionStatusInputSchema } from '@shared/schemas/shop-session'
import { evaluateRendererTrust } from '../../apps/desktop/src/main/services/renderer-trust-rules'

const mocks = vi.hoisted(() => {
  const stores = new Map<string, { deleted: boolean }>([
    ['store_a', { deleted: false }],
    ['store_b', { deleted: false }],
    ['store_deleted', { deleted: true }]
  ])
  const active = new Map<string, object>()
  const partitions = new Map<string, { clearStorageData: ReturnType<typeof vi.fn> }>()
  const getDatabase = vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((storeId: string) => {
        const row = stores.get(storeId)
        if (!row || (sql.includes('deleted_at IS NULL') && row.deleted)) return undefined
        return { id: storeId }
      })
    }))
  }))
  const getStoreSession = vi.fn((storeId: string) => {
    let session = active.get(storeId)
    if (!session) {
      session = { storeId }
      active.set(storeId, session)
    }
    return session
  })
  const waitForStoreSessionReady = vi.fn(async () => undefined)
  const closeStoreSession = vi.fn((storeId: string) => {
    active.delete(storeId)
  })
  const getStorePartition = vi.fn((storeId: string) => `persist:store_${storeId}`)
  const clearStoreSessionSnapshot = vi.fn()
  const fromPartition = vi.fn((partition: string) => {
    let value = partitions.get(partition)
    if (!value) {
      value = { clearStorageData: vi.fn(async () => undefined) }
      partitions.set(partition, value)
    }
    return value
  })
  return {
    stores,
    active,
    partitions,
    getDatabase,
    getStoreSession,
    waitForStoreSessionReady,
    closeStoreSession,
    getStorePartition,
    clearStoreSessionSnapshot,
    fromPartition
  }
})

vi.mock('electron', () => ({
  session: { fromPartition: mocks.fromPartition }
}))

vi.mock('../../apps/desktop/src/main/db/database', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('../../apps/desktop/src/main/browser/session-manager', () => ({
  getStoreSession: mocks.getStoreSession,
  waitForStoreSessionReady: mocks.waitForStoreSessionReady,
  closeStoreSession: mocks.closeStoreSession,
  getActiveSessions: () => mocks.active,
  getStorePartition: mocks.getStorePartition
}))

vi.mock('../../apps/desktop/src/main/services/session-persistence', () => ({
  clearStoreSessionSnapshot: mocks.clearStoreSessionSnapshot
}))

import {
  checkSessionHealth,
  closeStoreSession,
  destroyStoreSession,
  ensureSession,
  getSession,
  getSessionStatus,
  resetSessionStatusForTests
} from '../../apps/desktop/src/main/browser/shop-session-manager'

describe('ShopSessionManager', () => {
  beforeEach(() => {
    mocks.active.clear()
    mocks.partitions.clear()
    mocks.getStoreSession.mockClear()
    mocks.waitForStoreSessionReady.mockClear()
    mocks.closeStoreSession.mockClear()
    mocks.getStorePartition.mockClear()
    mocks.clearStoreSessionSnapshot.mockClear()
    mocks.fromPartition.mockClear()
    resetSessionStatusForTests()
  })

  it('为不同店铺复用不同底层 Session，并保持登录状态 UNKNOWN', () => {
    const a = getSession('store_a')
    const b = getSession('store_b')

    expect(a).not.toBe(b)
    expect(mocks.getStoreSession).toHaveBeenNthCalledWith(1, 'store_a')
    expect(mocks.getStoreSession).toHaveBeenNthCalledWith(2, 'store_b')
    expect(getSessionStatus('store_a')).toMatchObject({
      storeId: 'store_a',
      status: 'CHECKING',
      sessionPresent: true,
      loginStatus: 'UNKNOWN'
    })
    expect(getSessionStatus('store_b').loginStatus).toBe('UNKNOWN')
  })

  it('同一店铺多次获取返回同一个底层 Session', () => {
    const first = getSession('store_a')
    const second = getSession('store_a')

    expect(second).toBe(first)
    expect(mocks.getStoreSession).toHaveBeenCalledTimes(2)
  })

  it('ensureSession 等待底层配置后变为 READY，但不伪造平台登录', async () => {
    await ensureSession('store_a')

    expect(mocks.waitForStoreSessionReady).toHaveBeenCalledWith('store_a')
    expect(getSessionStatus('store_a')).toMatchObject({
      status: 'READY',
      sessionReady: true,
      healthy: true,
      loginStatus: 'UNKNOWN'
    })
  })

  it('close 只释放当前引用，不清理 partition 或 Cookie 快照', () => {
    getSession('store_a')
    getSession('store_b')
    closeStoreSession('store_a')

    expect(mocks.closeStoreSession).toHaveBeenCalledWith('store_a', { persist: true })
    expect(mocks.active.has('store_a')).toBe(false)
    expect(mocks.active.has('store_b')).toBe(true)
    expect(mocks.fromPartition).not.toHaveBeenCalled()
    expect(mocks.clearStoreSessionSnapshot).not.toHaveBeenCalled()
    expect(getSessionStatus('store_a')).toMatchObject({ status: 'UNKNOWN', sessionPresent: false })
  })

  it('destroy 只清理目标店铺，且不会影响其他店铺 Session', async () => {
    getSession('store_a')
    getSession('store_b')

    await destroyStoreSession('store_a')

    expect(mocks.closeStoreSession).toHaveBeenCalledWith('store_a', { persist: false })
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:store_store_a', { cache: true })
    expect(mocks.partitions.get('persist:store_store_a')?.clearStorageData).toHaveBeenCalledTimes(1)
    expect(mocks.clearStoreSessionSnapshot).toHaveBeenCalledWith('store_a')
    expect(mocks.active.has('store_a')).toBe(false)
    expect(mocks.active.has('store_b')).toBe(true)
  })

  it('拒绝不存在的 storeId，不能由 Renderer 构造任意 partition', () => {
    expect(() => getSession('persist:evil')).toThrow('STORE_NOT_FOUND')
    expect(() => getSessionStatus('missing')).toThrow('STORE_NOT_FOUND')
    expect(mocks.getStoreSession).not.toHaveBeenCalled()
  })

  it('状态摘要不含 Session、partition、Cookie 或 Token 原文', async () => {
    await checkSessionHealth('store_a')
    const summary = getSessionStatus('store_a') as Record<string, unknown>
    const serialized = JSON.stringify(summary)

    expect(summary.status).toBe('READY')
    expect(summary.loginStatus).toBe('UNKNOWN')
    expect(serialized).not.toContain('partition')
    expect(serialized).not.toContain('cookies')
    expect(serialized).not.toContain('token')
    expect('session' in summary).toBe(false)
  })

  it('Session 状态输入只允许合法 storeId，锁定态普通 IPC 仍由统一守卫拒绝', () => {
    expect(shopSessionStatusInputSchema.safeParse({ storeId: 'store_a' }).success).toBe(true)
    expect(shopSessionStatusInputSchema.safeParse({ storeId: '  ' }).success).toBe(false)
    expect(shopSessionStatusInputSchema.safeParse({ storeId: 'store_a', partition: 'persist:evil' }).success).toBe(false)

    const locked = evaluateRendererTrust({
      hostWebContentsId: 7,
      senderWebContentsId: 7,
      locked: true,
      allowWhenLocked: false,
      forbiddenCode: 'IPC_FORBIDDEN',
      feature: '会话与安全'
    })
    expect(locked).toMatchObject({ ok: false, code: 'APP_LOCKED' })
  })
})
