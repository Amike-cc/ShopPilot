import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { Session, WebContents } from 'electron'
import { findPlatform } from '@shared/constants/platforms'
import type { PlatformOrderCollectionResult } from '@shared/contracts/platform-adapter'
import type { PddOrderObservationFieldStructure } from '@shared/contracts/pdd-order-observation'
import { pddOrderObservationStartSchema } from '@shared/schemas/order'
import type { UnifiedOrder } from '@shared/contracts/unified-order'
import { PddAdapter } from '../../apps/desktop/src/main/platform-adapters/pdd-adapter'
import { ElectronNetworkObserver, type NetworkObservationResult, type NetworkObserver } from '../../apps/desktop/src/main/orders/network-observer'
import { decimalStringToMinor, normalizePddOrderStatus, parsePddOrderPayload } from '../../apps/desktop/src/main/orders/pdd-order-parser'
import { OrderRepository } from '../../apps/desktop/src/main/orders/order-repository'
import { OrderCollectionService, resetOrderCollectionLocksForTests, type OrderCollectionRuntime } from '../../apps/desktop/src/main/orders/order-collection-service'
import type { PlatformAdapter, OrderCapableAdapter } from '../../apps/desktop/src/main/platform-adapters/platform-adapter'

const pdd = findPlatform('拼多多')!

function observedResult(body: PddOrderObservationFieldStructure | null = null): NetworkObservationResult {
  const now = Date.now()
  return {
    startedAt: now - 5,
    finishedAt: now,
    requestCount: 1,
    jsonResponseCount: body == null ? 0 : 1,
    candidateOrderInterfaceCount: body?.candidate ? 1 : 0,
    observations: body == null ? [] : [{
      urlPattern: 'https://mms.pinduoduo.com/observed',
      method: 'GET',
      statusCode: 200,
      contentType: 'application/json',
      resourceType: 'fetch',
      contentLength: 100,
      responseTimeMs: 5,
      isJson: true,
      body
    }],
    reasonCode: 'NETWORK_OBSERVED'
  }
}

function fakeDebugger(body: string, emitResponse = true) {
  let listener: ((...args: unknown[]) => void) | null = null
  let detached = false
  const debuggerApi = {
    isAttached: () => false,
    attach: () => undefined,
    detach: () => { detached = true },
    on: (_event: 'message', next: (...args: unknown[]) => void) => { listener = next },
    removeListener: (_event: 'message', next: (...args: unknown[]) => void) => { if (listener === next) listener = null },
    sendCommand: async (method: string) => {
      if (method === 'Network.enable' && emitResponse) {
        listener?.({}, 'Network.requestWillBeSent', {
          requestId: 'r1', timestamp: 10, request: { method: 'POST', url: 'https://mms.pinduoduo.com/order/list?token=hidden' }
        })
        listener?.({}, 'Network.responseReceived', {
          requestId: 'r1', type: 'Fetch', response: {
            url: 'https://mms.pinduoduo.com/order/list?token=hidden', status: 200,
            mimeType: 'application/json', headers: { 'content-length': String(Buffer.byteLength(body)) }
          }
        })
        listener?.({}, 'Network.loadingFinished', { requestId: 'r1', timestamp: 10.01, encodedDataLength: Buffer.byteLength(body) })
      }
      if (method === 'Network.getResponseBody') return { body, base64Encoded: false }
      return {}
    }
  }
  return { debuggerApi, getListener: () => listener, wasDetached: () => detached }
}

describe('PDD order parser', () => {
  it('maps an observed order payload to UnifiedOrder with minor-unit money', () => {
    const result = parsePddOrderPayload({ data: { orders: [{
      orderId: 'PDD-1001',
      status: '已发货',
      totalAmountFen: 1999,
      paidAmountFen: 1999,
      createTime: '2026-09-27 10:00:00',
      buyer: { id: 'buyer-1', name: '买家' },
      items: [{ itemId: 'item-1', skuId: 'sku-1', title: '商品', quantity: 2, unitPriceFen: 999, totalPriceFen: 1998 }]
    }] } }, { storeId: 'store_a', collectedAt: 123 })
    expect(result.reasonCode).toBe('ORDER_PAYLOAD_PARSED')
    expect(result.orders).toHaveLength(1)
    expect(result.orders[0]).toMatchObject({
      platform: '拼多多', storeId: 'store_a', platformOrderId: 'PDD-1001',
      status: 'UNKNOWN', totalAmountMinor: 1999, paidAmountMinor: 1999, collectedAt: 123
    })
    expect(result.orders[0].items[0]).toMatchObject({ unitPriceMinor: 999, totalPriceMinor: 1998, quantity: 2 })
    expect(JSON.stringify(result.orders[0])).not.toMatch(/cookie|token|authorization|password/i)
  })

  it('keeps unknown status and missing fields instead of inventing values', () => {
    const result = parsePddOrderPayload({ orders: [{ orderId: 'PDD-1002', status: '平台新状态' }] }, { storeId: 'store_a' })
    expect(result.orders[0]).toMatchObject({ status: 'UNKNOWN', totalAmountMinor: null, paidAt: null })
    expect(normalizePddOrderStatus('平台新状态')).toBe('UNKNOWN')
    expect(decimalStringToMinor('¥19.90')).toBe(1990)
    expect(decimalStringToMinor('19.999')).toBeNull()
  })

  it('does not parse an unrecognized response as orders', () => {
    expect(parsePddOrderPayload({ data: { rows: [{ value: 'not an order' }] } }, { storeId: 'store_a' })).toMatchObject({
      orders: [], reasonCode: 'ORDER_ROWS_INVALID'
    })
  })
})

describe('PddAdapter order capability', () => {
  it('declares orders and collects only from injected observations', async () => {
    const shape: PddOrderObservationFieldStructure = {
      parseStatus: 'JSON', topLevelKeys: ['orders'], nestedKeys: ['orders[].status'],
      arrays: [{ path: 'orders', length: 1, itemType: 'object' }],
      fieldTypes: [{ path: 'orders[].status', type: 'string' }],
      suspectedFields: ['orders', 'status'], candidate: true, confidence: 'low', redactedFieldCount: 0
    }
    const observer = {
      observe: vi.fn(async () => observedResult(shape))
    }
    const adapter = new PddAdapter(pdd, { createNetworkObserver: () => observer })
    expect(adapter.getCapabilities().orders).toBe(true)
    const result = await adapter.collectOrders({
      storeId: 'store_a', platform: '拼多多', session: {} as Session,
      webContents: {} as WebContents, currentUrl: pdd.adminUrl, timeoutMs: 100
    }, { maxPages: 1, maxOrders: 10, timeoutMs: 100 })
    expect(result).toMatchObject({ status: 'OBSERVATION_ONLY', source: 'OBSERVATION_ONLY', fetchedCount: 0 })
    expect(result.observationReport?.candidateOrderInterfaceCount).toBe(1)
    expect(result.orders).toEqual([])
  })

  it('returns observation-only when no verified order shape is present', async () => {
    const adapter = new PddAdapter(pdd, {
      createNetworkObserver: () => ({ observe: async () => observedResult({
        parseStatus: 'JSON', topLevelKeys: ['metrics'], nestedKeys: [], arrays: [], fieldTypes: [],
        suspectedFields: [], candidate: false, confidence: 'low', redactedFieldCount: 0
      }) })
    })
    const result = await adapter.collectOrders({
      storeId: 'store_a', platform: '拼多多', session: {} as Session,
      webContents: {} as WebContents, currentUrl: pdd.adminUrl, timeoutMs: 100
    }, { maxPages: 1, maxOrders: 10, timeoutMs: 100 })
    expect(result).toMatchObject({ status: 'OBSERVATION_ONLY', source: 'OBSERVATION_ONLY' })
    expect(result.orders).toEqual([])
  })
})

describe('ElectronNetworkObserver cleanup', () => {
  it('removes the listener and detaches an observer-owned debugger', async () => {
    let listener: ((...args: unknown[]) => void) | null = null
    let detached = false
    const debuggerApi = {
      isAttached: () => false,
      attach: () => undefined,
      detach: () => { detached = true },
      on: (_event: 'message', next: (...args: unknown[]) => void) => { listener = next },
      removeListener: (_event: 'message', next: (...args: unknown[]) => void) => { if (listener === next) listener = null },
      sendCommand: async (method: string) => {
        if (method === 'Network.enable') {
          listener?.({}, 'Network.requestWillBeSent', {
            requestId: 'r1', timestamp: 10, request: { method: 'GET', url: 'https://mms.pinduoduo.com/data?token=secret' }
          })
          listener?.({}, 'Network.responseReceived', {
            requestId: 'r1', type: 'Fetch', response: { url: 'https://mms.pinduoduo.com/data', status: 200, mimeType: 'application/json' }
          })
          listener?.({}, 'Network.loadingFinished', { requestId: 'r1', timestamp: 10.005, encodedDataLength: 14 })
        }
        if (method === 'Network.getResponseBody') return { body: '{"orders":[]}', base64Encoded: false }
        return {}
      }
    }
    const wc = { isDestroyed: () => false, debugger: debuggerApi } as unknown as WebContents
    const observer = new ElectronNetworkObserver(wc)
    await observer.start({ timeoutMs: 1000 })
    const result = await observer.stop()
    expect(result.observations).toHaveLength(1)
    expect(result.requestCount).toBe(1)
    expect(result.observations[0].method).toBe('GET')
    expect(result.observations[0].urlPattern).toBe('https://mms.pinduoduo.com/data')
    expect(result.observations[0].body?.topLevelKeys).toContain('orders')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(listener).toBeNull()
    expect(detached).toBe(true)
  })

  it('只返回 JSON 结构并脱敏敏感字段', async () => {
    const fake = fakeDebugger(JSON.stringify({
      orders: [{ orderId: 'PDD-SECRET', status: '已发货' }],
      buyerPhone: '13800000000',
      shippingAddress: '秘密地址',
      authorization: 'Bearer secret-token'
    }))
    const wc = { isDestroyed: () => false, debugger: fake.debuggerApi } as unknown as WebContents
    const result = await new ElectronNetworkObserver(wc).observe({ timeoutMs: 1000 })
    const observation = result.observations[0]
    expect(observation.body?.topLevelKeys).toContain('orders')
    expect(observation.body?.redactedFieldCount).toBe(3)
    expect(observation.body?.suspectedFields).toContain('orders')
    expect(JSON.stringify(result)).not.toContain('13800000000')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('秘密地址')
  })

  it('超出正文上限时只返回 TRUNCATED，不保存正文', async () => {
    const body = JSON.stringify({ orders: [{ status: 'PAID' }], payload: 'x'.repeat(20000) })
    const fake = fakeDebugger(body)
    const wc = { isDestroyed: () => false, debugger: fake.debuggerApi } as unknown as WebContents
    const result = await new ElectronNetworkObserver(wc).observe({ timeoutMs: 1000, maxBodyBytes: 16 * 1024 })
    expect(result.observations[0].body?.parseStatus).toBe('TRUNCATED')
    expect(JSON.stringify(result)).not.toContain('x'.repeat(100))
  })

  it('超时后清理监听器和调试器', async () => {
    const fake = fakeDebugger('', false)
    const wc = { isDestroyed: () => false, debugger: fake.debuggerApi } as unknown as WebContents
    const result = await new ElectronNetworkObserver(wc).observe({ timeoutMs: 1000 })
    expect(result.reasonCode).toBe('NETWORK_OBSERVER_TIMEOUT')
    expect(fake.getListener()).toBeNull()
    expect(fake.wasDetached()).toBe(true)
  })
})

describe('PDD observation lifecycle', () => {
  it('支持 start/stop，并保持不同店铺观察相互隔离', async () => {
    const running = new Map<string, boolean>()
    const observers = new Map<string, NetworkObserver>()
    const adapter = new PddAdapter(pdd, {
      createNetworkObserver: (context) => {
        const observer: NetworkObserver = {
          observe: async () => observedResult(),
          start: async () => { running.set(context.storeId, true) },
          stop: async () => {
            running.set(context.storeId, false)
            return observedResult()
          },
          isRunning: () => running.get(context.storeId) === true
        }
        observers.set(context.storeId, observer)
        return observer
      }
    })
    const context = (storeId: string): Parameters<typeof adapter.startOrderObservation>[0] => ({
      storeId, platform: '拼多多', session: {} as Session, webContents: {} as WebContents,
      currentUrl: 'https://mms.pinduoduo.com/order', timeoutMs: 1000
    })
    expect((await adapter.startOrderObservation(context('store_a'), { timeoutMs: 1000, maxResponses: 10 })).status).toBe('STARTED')
    expect((await adapter.startOrderObservation(context('store_b'), { timeoutMs: 1000, maxResponses: 10 })).status).toBe('STARTED')
    expect(running.get('store_a')).toBe(true)
    expect(running.get('store_b')).toBe(true)
    expect((await adapter.stopOrderObservation('store_a')).status).toBe('STOPPED')
    expect(running.get('store_a')).toBe(false)
    expect(running.get('store_b')).toBe(true)
    expect(observers.has('store_b')).toBe(true)
    expect((await adapter.stopOrderObservation('store_b')).status).toBe('STOPPED')
  })

  it('拒绝 Renderer 传入 partition、Cookie 或 Token 字段', () => {
    expect(pddOrderObservationStartSchema.safeParse({ storeId: 'store_a', partition: 'persist:other' }).success).toBe(false)
    expect(pddOrderObservationStartSchema.safeParse({ storeId: 'store_a', cookie: 'secret' }).success).toBe(false)
    expect(pddOrderObservationStartSchema.safeParse({ storeId: 'store_a', token: 'secret' }).success).toBe(false)
    expect(pddOrderObservationStartSchema.safeParse({ storeId: 'store_a', timeoutMs: 1000, maxResponses: 20 }).success).toBe(true)
  })
})

function sampleOrder(status: UnifiedOrder['status'] = 'PAID'): UnifiedOrder {
  return {
    id: '', platform: '拼多多', storeId: 'store_a', platformOrderId: 'PDD-REPO-1', status,
    platformStatus: status, totalAmountMinor: 1000, paidAmountMinor: 1000, refundAmountMinor: null,
    currency: 'CNY', buyer: null, items: [], createdAt: 100, paidAt: 110, shippedAt: null,
    completedAt: null, updatedAt: 120, collectedAt: 130, sourceUpdatedAt: 120,
    rawSnapshot: { platformOrderId: 'PDD-REPO-1', status }
  }
}

describe('OrderRepository', () => {
  const require_ = createRequire(import.meta.url)
  const DatabaseSync = (() => {
    try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => unknown }).DatabaseSync || null } catch { return null }
  })()
  const realIt = DatabaseSync ? it : it.skip

  realIt('upserts by platform + store + platform order ID and replaces items', () => {
    const db = new (DatabaseSync as new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }; close(): void })(':memory:')
    db.exec(`CREATE TABLE stores (id TEXT PRIMARY KEY); INSERT INTO stores VALUES ('store_a');
      CREATE TABLE orders (id TEXT PRIMARY KEY, platform TEXT NOT NULL, store_id TEXT NOT NULL, platform_order_id TEXT NOT NULL,
        status TEXT NOT NULL, platform_status TEXT, total_amount_minor INTEGER, paid_amount_minor INTEGER, refund_amount_minor INTEGER,
        currency TEXT NOT NULL, buyer_json TEXT, order_created_at INTEGER, paid_at INTEGER, shipped_at INTEGER, completed_at INTEGER,
        platform_updated_at INTEGER, collected_at INTEGER NOT NULL, source_updated_at INTEGER, raw_snapshot_json TEXT, stored_at INTEGER NOT NULL,
        UNIQUE(platform, store_id, platform_order_id));
      CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, platform_item_id TEXT, platform_sku_id TEXT, title TEXT,
        sku_name TEXT, quantity INTEGER, unit_price_minor INTEGER, total_price_minor INTEGER, image_url TEXT, created_at INTEGER NOT NULL);`)
    const repo = new OrderRepository(db as never)
    expect(repo.upsertOrders([sampleOrder()])).toMatchObject({ insertedCount: 1, updatedCount: 0 })
    expect(repo.upsertOrders([sampleOrder('SHIPPED')])).toMatchObject({ insertedCount: 0, updatedCount: 1 })
    const listed = repo.list({ storeId: 'store_a', page: 1, pageSize: 20 })
    expect(listed.total).toBe(1)
    expect(listed.orders[0]).toMatchObject({ platformOrderId: 'PDD-REPO-1', status: 'SHIPPED' })
    expect(JSON.stringify(listed.orders[0])).not.toContain('rawSnapshot')
    db.close()
  })
})

describe('OrderCollectionService gates', () => {
  beforeEach(() => resetOrderCollectionLocksForTests())

  it('rejects non-PDD stores before adapter collection', async () => {
    const collect = vi.fn()
    const runtime = fakeRuntime({
      store: { id: 'store_a', platform: '抖店' },
      adapter: { platform: '抖店', getCapabilities: () => ({ loginDetection: true, orders: false, products: false, inventory: false, refunds: false, salesData: false }), collectOrders: collect } as never
    })
    const result = await new OrderCollectionService(runtime).collect({ storeId: 'store_a', maxPages: 1, maxOrders: 10, timeoutMs: 1000 })
    expect(result.reasonCode).toBe('UNSUPPORTED_PLATFORM')
    expect(collect).not.toHaveBeenCalled()
  })

  it('returns ALREADY_RUNNING for a second collection in the same store', async () => {
    let resolveCollection: ((value: PlatformOrderCollectionResult) => void) | null = null
    const adapter: OrderCapableAdapter = {
      adapterName: 'TestPdd', platform: '拼多多', supports: () => true,
      getCapabilities: () => ({ loginDetection: true, orders: true, products: false, inventory: false, refunds: false, salesData: false }),
      detectLoginStatus: async () => ({ platform: '拼多多', storeId: 'store_a', status: 'UNKNOWN', checkedAt: Date.now(), reasonCode: 'TEST', safeMessage: '', evidenceType: 'NONE' }),
      collectOrders: async () => new Promise(resolve => { resolveCollection = resolve })
    }
    const runtime = fakeRuntime({ adapter })
    const service = new OrderCollectionService(runtime)
    const first = service.collect({ storeId: 'store_a', maxPages: 1, maxOrders: 10, timeoutMs: 1000 })
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await service.collect({ storeId: 'store_a', maxPages: 1, maxOrders: 10, timeoutMs: 1000 })
    expect(second.status).toBe('ALREADY_RUNNING')
    resolveCollection!({ status: 'OBSERVATION_ONLY', source: 'OBSERVATION_ONLY', orders: [], fetchedCount: 0, skippedCount: 0, observedResponseCount: 0, nextCursor: null, hasMore: false, reasonCode: 'ORDER_DATA_SOURCE_UNVERIFIED', safeMessage: 'safe' })
    expect((await first).status).toBe('OBSERVATION_ONLY')
  })
})

function fakeRuntime(options: {
  store?: { id: string; platform: string }
  adapter?: PlatformAdapter
} = {}): OrderCollectionRuntime {
  const store = options.store || { id: 'store_a', platform: '拼多多' }
  const session = {} as Session
  const webContents = { isDestroyed: () => false, session, getURL: () => 'https://mms.pinduoduo.com/home' } as unknown as WebContents
  const defaultAdapter: OrderCapableAdapter = {
    adapterName: 'TestPdd', platform: '拼多多', supports: () => true,
    getCapabilities: () => ({ loginDetection: true, orders: true, products: false, inventory: false, refunds: false, salesData: false }),
    detectLoginStatus: async () => ({ platform: '拼多多', storeId: 'store_a', status: 'UNKNOWN', checkedAt: Date.now(), reasonCode: 'TEST', safeMessage: '', evidenceType: 'NONE' }),
    collectOrders: async () => ({ status: 'OBSERVATION_ONLY', source: 'OBSERVATION_ONLY', orders: [], fetchedCount: 0, skippedCount: 0, observedResponseCount: 0, nextCursor: null, hasMore: false, reasonCode: 'ORDER_DATA_SOURCE_UNVERIFIED', safeMessage: 'safe' })
  }
  const repository = { upsertOrders: vi.fn(() => ({ insertedCount: 0, updatedCount: 0, skippedCount: 0 })), list: vi.fn(), getOrderById: vi.fn() } as unknown as OrderRepository
  return {
    getStore: vi.fn(() => store as never),
    ensureSession: vi.fn(async () => session),
    getSessionStatus: vi.fn(() => ({ storeId: store.id, status: 'READY', sessionPresent: true, sessionReady: true, healthy: true, loginStatus: 'UNKNOWN', platform: store.platform, lastCheckedAt: Date.now(), loginCheckedAt: null, loginReasonCode: null, loginSafeMessage: null, loginEvidenceType: null, errorCode: null })),
    // 页面句柄现在要等渲染层 DOM <webview> 注册完成：服务侧接口是"等到可用为止"
    waitForStoreWebContents: vi.fn(async () => webContents),
    getAdapter: vi.fn(() => options.adapter || defaultAdapter),
    detectLoginStatus: vi.fn(async () => ({ platform: store.platform, storeId: store.id, status: 'UNKNOWN', checkedAt: Date.now(), reasonCode: 'TEST', safeMessage: '', evidenceType: 'NONE' })),
    isLocked: () => false,
    repository
  }
}
