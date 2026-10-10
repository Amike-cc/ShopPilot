import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const inserted: unknown[][] = []
  const db = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      run: vi.fn((...values: unknown[]) => { inserted.push(values); return { changes: 1 } })
    }))
  }
  return { inserted, db, getStore: vi.fn(), listStores: vi.fn(() => []), emit: vi.fn() }
})

vi.mock('electron', () => ({}))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => mocks.db }))
vi.mock('../../apps/desktop/src/main/stores/store-manager', () => ({ getStore: mocks.getStore, listStores: mocks.listStores }))
vi.mock('../../apps/desktop/src/main/browser/window-manager', () => ({
  borrowCollectionPage: vi.fn(),
  emitToRenderer: mocks.emit
}))
vi.mock('../../apps/desktop/src/main/services/logger', () => ({ logMain: vi.fn() }))

import {
  buildCustomerMessageProbeScript,
  CustomerMessageMonitor,
  interpretCustomerMessageProbe
} from '../../apps/desktop/src/main/services/customer-message-monitor'
import { isCustomerMessageCheckFresh } from '../../packages/shared/src/contracts/customer-service'

describe('客服消息监控', () => {
  it('只把实时窗口内的检查当作可用摘要', () => {
    expect(isCustomerMessageCheckFresh(1_000, 91_000)).toBe(true)
    expect(isCustomerMessageCheckFresh(1_000, 91_001)).toBe(false)
    expect(isCustomerMessageCheckFresh(0, 1_000)).toBe(false)
  })
  it('探针只返回结构化计数和证据，不返回正文', () => {
    const script = buildCustomerMessageProbeScript(['客服', '会话'])
    expect(script).toContain('unreadCount')
    expect(script).toContain('conversationCount')
    expect(script).not.toContain('return document.body.innerText')
    expect(script).not.toContain('return document.body.textContent')
  })

  it('登录页证据不会被当作 0 条消息', () => {
    const result = interpretCustomerMessageProbe({ documentReady: true, messageContext: false, loginSignals: 2 })
    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(result.unreadCount).toBeNull()
    expect(result.conversationCount).toBeNull()
  })

  it('页面改版或缺少计数证据时保持未验证', () => {
    expect(interpretCustomerMessageProbe({ documentReady: true, messageContext: false }).status).toBe('PAGE_CHANGED')
    const noCount = interpretCustomerMessageProbe({ documentReady: true, messageContext: true, conversationSignals: 1 })
    expect(noCount.status).toBe('NOT_VERIFIED')
    expect(noCount.unreadCount).toBeNull()
    expect(noCount.conversationCount).toBeNull()
  })

  it('真实摘要可通过独立页面运行时保存并广播', async () => {
    mocks.inserted.length = 0
    mocks.getStore.mockReturnValue({ id: 'store-1', platform: '抖店' })
    const wc = {
      isDestroyed: () => false,
      loadURL: vi.fn(async () => undefined),
      executeJavaScript: vi.fn(async () => ({
        documentReady: true, messageContext: true, unreadCount: 3, conversationCount: 2,
        unreadSignals: 1, conversationSignals: 2, loginSignals: 0
      }))
    } as any
    const release = vi.fn()
    const monitor = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: () => ({ waitForWebContents: async () => wc, release }),
      emit: mocks.emit
    })
    const result = await monitor.check('store-1')
    expect(result.status).toBe('AVAILABLE')
    expect(result.unreadCount).toBe(3)
    expect(result.conversationCount).toBe(2)
    expect(wc.loadURL).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.inserted).toHaveLength(2)
    expect(mocks.emit).toHaveBeenCalledTimes(2)
    expect(mocks.emit.mock.calls.map(call => (call[1] as any).status)).toEqual(['CHECKING', 'AVAILABLE'])
  })

  it('应用锁定时不创建客服页面、不读取店铺列表，也不写入监控台账', async () => {
    mocks.inserted.length = 0
    mocks.emit.mockClear()
    const borrowPage = vi.fn()
    const listStores = mocks.listStores
    listStores.mockClear()
    const monitor = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: borrowPage as any,
      emit: mocks.emit,
      isLocked: () => true
    })

    await expect(monitor.check('store-locked')).resolves.toMatchObject({ status: 'ERROR', reasonCode: 'APP_LOCKED' })
    await expect(monitor.checkAll()).resolves.toBeUndefined()
    expect(borrowPage).not.toHaveBeenCalled()
    expect(listStores).not.toHaveBeenCalled()
    expect(mocks.inserted).toHaveLength(0)
  })

  it('锁定只暂停原本运行的监控，解锁后恢复；手动停止不会被偷偷重启', () => {
    let locked = false
    const closeAll = vi.fn()
    const monitor = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: () => ({ waitForWebContents: async () => null, release: vi.fn() }),
      emit: mocks.emit,
      closeAll,
      isLocked: () => locked
    })

    monitor.start()
    locked = true
    monitor.pauseForAppLock()
    expect(closeAll).toHaveBeenCalledTimes(1)
    locked = false
    monitor.resumeAfterAppUnlock()
    monitor.stop()
    expect(closeAll).toHaveBeenCalledTimes(2)

    const neverStarted = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: () => ({ waitForWebContents: async () => null, release: vi.fn() }),
      emit: mocks.emit,
      closeAll,
      isLocked: () => false
    })
    neverStarted.pauseForAppLock()
    neverStarted.resumeAfterAppUnlock()
    neverStarted.stop()
    expect(closeAll).toHaveBeenCalledTimes(4)
  })

  it('监控停止后迟到的页面结果不会写库或广播', async () => {
    mocks.inserted.length = 0
    mocks.emit.mockClear()
    let releaseLoad: (() => void) | null = null
    const loadFinished = new Promise<void>(resolve => { releaseLoad = resolve })
    const wc = {
      isDestroyed: () => false,
      loadURL: vi.fn(() => loadFinished),
      executeJavaScript: vi.fn(async () => ({
        documentReady: true, messageContext: true, unreadCount: 1, conversationCount: 1,
        unreadSignals: 1, conversationSignals: 1, loginSignals: 0
      }))
    } as any
    const monitor = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: () => ({ waitForWebContents: async () => wc, release: vi.fn() }),
      emit: mocks.emit,
      closeAll: vi.fn()
    })
    const checking = monitor.check('store-1')
    await Promise.resolve()
    monitor.stop()
    releaseLoad?.()
    await expect(checking).resolves.toMatchObject({ status: 'ERROR', reasonCode: 'MONITOR_STOPPED' })
    expect(mocks.inserted).toHaveLength(0)
    expect(mocks.emit.mock.calls.map(call => (call[1] as any).reasonCode)).toEqual(['CHECK_IN_PROGRESS'])
  })

  it('店铺删除竞态不会把第二次请求误报为检查中', async () => {
    let releasePage: (() => void) | null = null
    const pageReady = new Promise<void>(resolve => { releasePage = resolve })
    let alive = true
    mocks.getStore.mockImplementation((storeId: string) => alive ? { id: storeId, platform: '抖店' } : null)
    const monitor = new CustomerMessageMonitor({
      now: () => 1_700_000_000_000,
      borrowPage: () => ({
        waitForWebContents: async () => { await pageReady; return null },
        release: vi.fn()
      }),
      emit: mocks.emit
    })
    const first = monitor.check('store-race')
    await Promise.resolve()
    alive = false
    await expect(monitor.check('store-race')).rejects.toThrow('STORE_NOT_FOUND')
    releasePage?.()
    await first
    mocks.getStore.mockReturnValue({ id: 'store-1', platform: '抖店' })
  })
})
