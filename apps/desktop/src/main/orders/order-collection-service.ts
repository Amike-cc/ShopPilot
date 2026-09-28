import type { Session, WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import type {
  OrderCollectionResult,
  OrderListQuery,
  OrderListResult,
  SafeUnifiedOrder
} from '@shared/contracts/unified-order'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type { ShopSessionStatusSummary } from '@shared/contracts/shop-session'
import type { PlatformAdapter, OrderCapableAdapter } from '../platform-adapters/platform-adapter'
import { platformAdapterRegistry } from '../platform-adapters/platform-adapter-registry'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import * as StoreManager from '../stores/store-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { waitForStoreWebContents } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { isAppLocked } from '../services/security-manager'
import { logMain } from '../services/logger'
import { OrderRepository, safeOrder } from './order-repository'

export interface OrderCollectionInput {
  storeId: string
  maxPages: number
  maxOrders: number
  timeoutMs: number
}

export interface OrderCollectionRuntime {
  getStore: (storeId: string) => Store | null
  ensureSession: (storeId: string) => Promise<Session>
  getSessionStatus: (storeId: string) => ShopSessionStatusSummary
  /** 等店铺页面可用（含 DOM <webview> guest 注册）：页面现在由渲染层承载，开店后需要一点时间 */
  waitForStoreWebContents: (storeId: string) => Promise<WebContents | null>
  getAdapter: (platform: string) => PlatformAdapter | null
  detectLoginStatus: (storeId: string) => Promise<PlatformLoginResult>
  isLocked: () => boolean
  repository: OrderRepository
}

function createDefaultRuntime(): OrderCollectionRuntime {
  // 延迟到第一次调用时获取数据库；Main 模块导入发生在 app 初始化之前。
  return {
    getStore: StoreManager.getStore,
    ensureSession: ShopSessionManager.ensureSession,
    getSessionStatus: ShopSessionManager.getSessionStatus,
    waitForStoreWebContents,
    getAdapter: (platform) => platformAdapterRegistry.resolveAdapter(platform),
    detectLoginStatus: detectStoreLoginStatus,
    isLocked: isAppLocked,
    repository: new OrderRepository(getDatabase())
  }
}

const inFlight = new Map<string, Promise<OrderCollectionResult>>()

function assertStoreId(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) throw new Error('INVALID_ARGUMENT')
  return storeId.trim()
}

function baseResult(storeId: string, platform: string, startedAt: number): OrderCollectionResult {
  return {
    storeId,
    platform,
    status: 'FAILED',
    source: 'OBSERVATION_ONLY',
    startedAt,
    finishedAt: Date.now(),
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    observedResponseCount: 0,
    nextCursor: null,
    hasMore: false,
    reasonCode: 'ORDER_COLLECTION_FAILED',
    safeMessage: '订单采集失败'
  }
}

function isOrderCapable(adapter: PlatformAdapter | null): adapter is OrderCapableAdapter {
  if (!adapter || !adapter.getCapabilities().orders) return false
  return typeof (adapter as Partial<OrderCapableAdapter>).collectOrders === 'function'
}

function currentUrl(webContents: WebContents): string {
  try { return String(webContents.getURL() || '') } catch { return '' }
}

export class OrderCollectionService {
  private readonly runtimeFactory: () => OrderCollectionRuntime

  constructor(runtime?: OrderCollectionRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  private get runtime(): OrderCollectionRuntime { return this.runtimeFactory() }

  collect(input: OrderCollectionInput): Promise<OrderCollectionResult> {
    const storeId = assertStoreId(input.storeId)
    const current = inFlight.get(storeId)
    if (current) {
      const store = this.runtime.getStore(storeId)
      const platform = store?.platform || '拼多多'
      const startedAt = Date.now()
      return Promise.resolve({
        ...baseResult(storeId, platform, startedAt),
        status: 'ALREADY_RUNNING',
        reasonCode: 'ALREADY_RUNNING',
        safeMessage: '该店铺正在采集订单，请等待当前采集完成'
      })
    }
    const promise = this.run({ ...input, storeId })
    inFlight.set(storeId, promise)
    return promise.finally(() => {
      if (inFlight.get(storeId) === promise) inFlight.delete(storeId)
    })
  }

  private async run(input: OrderCollectionInput): Promise<OrderCollectionResult> {
    const startedAt = Date.now()
    const store = this.runtime.getStore(input.storeId)
    const platform = store?.platform || '拼多多'
    const result = baseResult(input.storeId, platform, startedAt)
    try {
      if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
      if (!store) throw new Error('STORE_NOT_FOUND')
      if (store.platform !== '拼多多') {
        result.reasonCode = 'UNSUPPORTED_PLATFORM'
        result.safeMessage = '当前阶段只支持拼多多订单采集'
        return this.finish(result)
      }

      const adapter = this.runtime.getAdapter(store.platform)
      if (!isOrderCapable(adapter)) {
        result.reasonCode = 'ORDERS_UNSUPPORTED'
        result.safeMessage = '该平台尚未实现订单采集能力'
        return this.finish(result)
      }

      const session = await this.runtime.ensureSession(input.storeId)
      const sessionStatus = this.runtime.getSessionStatus(input.storeId)
      if (sessionStatus.status !== 'READY' || !sessionStatus.sessionReady) {
        result.reasonCode = 'SESSION_NOT_READY'
        result.safeMessage = '店铺浏览器 Session 尚未就绪'
        return this.finish(result)
      }

      const webContents = await this.runtime.waitForStoreWebContents(input.storeId)
      if (!webContents || webContents.isDestroyed()) {
        result.reasonCode = 'PAGE_NOT_READY'
        result.safeMessage = '请先打开拼多多店铺页面'
        return this.finish(result)
      }
      try {
        if (webContents.session && webContents.session !== session) {
          result.reasonCode = 'SESSION_MISMATCH'
          result.safeMessage = '店铺浏览器 Session 不匹配，已拒绝采集'
          return this.finish(result)
        }
      } catch {
        result.reasonCode = 'SESSION_MISMATCH'
        result.safeMessage = '店铺浏览器 Session 不匹配，已拒绝采集'
        return this.finish(result)
      }

      // PDD 当前尚无可靠生产登录检测器：UNKNOWN 允许进入观察模式；明确的登录/验证/错误状态必须阻断。
      const login = await this.runtime.detectLoginStatus(input.storeId)
      if (login.status === 'LOGIN_REQUIRED' || login.status === 'VERIFY_REQUIRED' || login.status === 'ERROR') {
        result.reasonCode = login.status
        result.safeMessage = login.safeMessage
        return this.finish(result)
      }

      const adapterResult = await adapter.collectOrders({
        storeId: input.storeId,
        platform: store.platform,
        session,
        webContents,
        currentUrl: currentUrl(webContents),
        timeoutMs: input.timeoutMs
      }, {
        maxPages: input.maxPages,
        maxOrders: input.maxOrders,
        timeoutMs: input.timeoutMs
      })
      result.status = adapterResult.status
      result.source = adapterResult.source
      result.fetchedCount = adapterResult.fetchedCount
      result.skippedCount = adapterResult.skippedCount
      result.observedResponseCount = adapterResult.observedResponseCount
      result.nextCursor = adapterResult.nextCursor
      result.hasMore = adapterResult.hasMore
      result.reasonCode = adapterResult.reasonCode
      result.safeMessage = adapterResult.safeMessage
      if (adapterResult.status === 'SUCCEEDED' || adapterResult.status === 'PARTIAL') {
        const validOrders = adapterResult.orders.filter(order => order.storeId === input.storeId && order.platform === store.platform)
        result.skippedCount += adapterResult.orders.length - validOrders.length
        if (validOrders.length !== adapterResult.orders.length) {
          result.status = validOrders.length ? 'PARTIAL' : 'FAILED'
          result.reasonCode = 'ORDER_STORE_MISMATCH'
          result.safeMessage = '订单店铺归属校验失败，未写入不匹配数据'
        }
        if (validOrders.length) {
          const counts = this.runtime.repository.upsertOrders(validOrders)
          result.insertedCount = counts.insertedCount
          result.updatedCount = counts.updatedCount
          result.skippedCount += counts.skippedCount
        }
      }
      return this.finish(result)
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      result.reasonCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'ORDER_COLLECTION_FAILED'
      result.safeMessage = code === 'APP_LOCKED' ? '应用已锁定' : code === 'STORE_NOT_FOUND' ? '店铺不存在或已删除' : '订单采集失败'
      return this.finish(result)
    }
  }

  private finish(result: OrderCollectionResult): OrderCollectionResult {
    result.finishedAt = Date.now()
    logMain('info', `[orders] ${JSON.stringify({
      platform: result.platform,
      storeId: result.storeId,
      operation: 'collectOrders',
      duration: result.finishedAt - result.startedAt,
      result: result.status,
      source: result.source,
      reasonCode: result.reasonCode,
      fetchedCount: result.fetchedCount,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount
    })}`)
    return result
  }

  list(query: OrderListQuery): OrderListResult {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    if (!this.runtime.getStore(query.storeId)) throw new Error('STORE_NOT_FOUND')
    return this.runtime.repository.list(query)
  }

  get(storeId: string, orderId: string): SafeUnifiedOrder | null {
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const id = assertStoreId(storeId)
    if (!this.runtime.getStore(id)) throw new Error('STORE_NOT_FOUND')
    const order = this.runtime.repository.getOrderById(id, orderId)
    return order ? safeOrder(order) : null
  }
}

export const orderCollectionService = new OrderCollectionService()

export function resetOrderCollectionLocksForTests(): void {
  inFlight.clear()
}
