import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  getStoreSession: vi.fn(),
  getActiveStoreSession: vi.fn(),
  getCustomerServiceSession: vi.fn(),
  getActiveCustomerServiceSession: vi.fn(),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/shopilot-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString
  }
}))
vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
  renameSync: mocks.renameSync,
  rmSync: mocks.rmSync,
  writeFileSync: mocks.writeFileSync
}))
vi.mock('../../apps/desktop/src/main/browser/session-manager', () => ({
  getStoreSession: mocks.getStoreSession,
  getActiveStoreSession: mocks.getActiveStoreSession,
  getCustomerServiceSession: mocks.getCustomerServiceSession,
  getActiveCustomerServiceSession: mocks.getActiveCustomerServiceSession
}))
vi.mock('../../apps/desktop/src/main/services/logger', () => ({ logMain: vi.fn() }))

import {
  clearStoreSessionSnapshot,
  snapshotStoreSession
} from '../../apps/desktop/src/main/services/session-persistence'

describe('会话快照并发收敛', () => {
  it('同一店铺的异步 Cookie 读取按调用顺序串行写入', async () => {
    mocks.encryptString.mockClear()
    mocks.renameSync.mockClear()
    let releaseFirst: (() => void) | null = null
    const firstRead = new Promise<void>(resolve => { releaseFirst = resolve })
    const session = {
      cookies: {
        get: vi.fn()
          .mockImplementationOnce(async () => { await firstRead; return [{ name: 'old', domain: 'example.com', value: '1' }] })
          .mockResolvedValueOnce([{ name: 'new', domain: 'example.com', value: '2' }])
      }
    } as any
    mocks.getActiveStoreSession.mockReturnValue(session)

    const first = snapshotStoreSession('store-a')
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = snapshotStoreSession('store-a')
    expect(session.cookies.get).toHaveBeenCalledTimes(1)
    releaseFirst?.()
    await Promise.all([first, second])

    expect(session.cookies.get).toHaveBeenCalledTimes(2)
    const payloads = mocks.encryptString.mock.calls.slice(-2).map(call => JSON.parse(call[0]).cookies[0].name)
    expect(payloads).toEqual(['old', 'new'])
    expect(mocks.renameSync).toHaveBeenCalledTimes(2)
  })

  it('清理快照会使在途读取失效，旧结果不能重新写回磁盘', async () => {
    let release: (() => void) | null = null
    const pending = new Promise<void>(resolve => { release = resolve })
    const session = { cookies: { get: vi.fn(async () => { await pending; return [{ name: 'stale', domain: 'example.com', value: '1' }] }) } } as any
    mocks.getActiveStoreSession.mockReturnValue(session)
    mocks.renameSync.mockClear()
    const before = mocks.renameSync.mock.calls.length
    const snapshot = snapshotStoreSession('store-b')
    await Promise.resolve()
    clearStoreSessionSnapshot('store-b')
    release?.()
    await snapshot
    expect(mocks.renameSync.mock.calls.length).toBe(before)
  })
})
