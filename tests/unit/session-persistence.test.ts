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
  fromPartition: vi.fn(),
  getDatabase: vi.fn(),
  closeCustomerServiceSession: vi.fn(),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/shopilot-test' },
  session: { fromPartition: mocks.fromPartition },
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
  getActiveCustomerServiceSession: mocks.getActiveCustomerServiceSession,
  closeCustomerServiceSession: mocks.closeCustomerServiceSession
}))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('../../apps/desktop/src/main/services/logger', () => ({ logMain: vi.fn() }))

import {
  clearStoreSessionSnapshot,
  restoreCustomerServiceSession,
  snapshotStoreSession
} from '../../apps/desktop/src/main/services/session-persistence'

/**
 * 测试用 Cookie 记录：Electron Cookie 的一个最小子集。
 * 迁移时会给补进来的旧 Cookie 补 sameSite，所以形状里必须有这个可选字段
 * （否则 `currentCookies.push(...)` 会被推断出的窄字面量类型挡住）。
 */
interface TestCookie {
  name: string
  domain: string
  path: string
  value: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: string
}

describe('会话快照并发收敛', () => {
  it('同一店铺的异步 Cookie 读取按调用顺序串行写入', async () => {
    mocks.encryptString.mockClear()
    mocks.renameSync.mockClear()
    // 不在声明处初始化：Promise 回调里才赋值，若初始化成 null，TS 会把它收窄成 null 并判定 release?.() 不可调用。
    let releaseFirst: (() => void) | undefined
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
    let release: (() => void) | undefined
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

  it('迁移旧客服 Cookie 时保留工作台同键新值，只补入缺失的平台 Cookie', async () => {
    const currentCookies: TestCookie[] = [
      { name: 'session', domain: 'im.jinritemai.com', path: '/', value: 'workbench-current', secure: true, httpOnly: true, expirationDate: Date.now() / 1000 + 3600 }
    ]
    const legacyCookies = [
      { name: 'session', domain: 'im.jinritemai.com', path: '/', value: 'legacy-stale', secure: true, httpOnly: true, expirationDate: Date.now() / 1000 + 3600 },
      { name: 'csrf', domain: 'im.jinritemai.com', path: '/', value: 'legacy-missing', secure: true, httpOnly: false, expirationDate: Date.now() / 1000 + 3600 },
      { name: 'unrelated', domain: '.example.com', path: '/', value: 'unrelated', secure: true, httpOnly: false, expirationDate: Date.now() / 1000 + 3600 }
    ]
    const sharedSession = {
      cookies: {
        get: vi.fn(async () => [...currentCookies]),
        set: vi.fn(async (cookie: { name: string; domain?: string; path?: string; value: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }) => {
          const key = `${cookie.name}\u0000${cookie.domain || ''}\u0000${cookie.path || '/'}`
          const existing = currentCookies.find(item => `${item.name}\u0000${item.domain}\u0000${item.path}` === key)
          if (existing) Object.assign(existing, cookie)
          else currentCookies.push({ ...cookie, domain: cookie.domain || '.jinritemai.com', path: cookie.path || '/', sameSite: 'unspecified' })
        })
      },
      clearStorageData: vi.fn(async () => {})
    } as any
    const legacySession = { cookies: { get: vi.fn(async () => legacyCookies) }, clearStorageData: vi.fn(async () => {}) } as any
    mocks.existsSync.mockReturnValue(false)
    mocks.getDatabase.mockReturnValue({ prepare: (sql: string) => ({ get: () => sql.toLowerCase().includes('platform') ? { platform: '抖店' } : { id: 'store-migration' } }) })
    mocks.getCustomerServiceSession.mockReturnValue(sharedSession)
    mocks.getActiveStoreSession.mockReturnValue(sharedSession)
    mocks.fromPartition.mockReturnValue(legacySession)

    const migrated = await restoreCustomerServiceSession('store-migration')
    expect(migrated).toBe(1)
    expect(sharedSession.cookies.set).toHaveBeenCalledTimes(1)
    expect(sharedSession.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'csrf', value: 'legacy-missing' }))
    expect(currentCookies.find(cookie => cookie.name === 'session')?.value).toBe('workbench-current')
    expect(currentCookies.some(cookie => cookie.name === 'unrelated')).toBe(false)
    expect(legacySession.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] })
  })
})
