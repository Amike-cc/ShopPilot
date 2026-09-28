import type { Session, WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import type {
  PddOrderObservationStartOptions,
  PddOrderObservationStartResult,
  PddOrderObservationStopResult
} from '@shared/contracts/pdd-order-observation'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type { ShopSessionStatusSummary } from '@shared/contracts/shop-session'
import type {
  OrderObservationCapableAdapter,
  PlatformAdapter
} from '../platform-adapters/platform-adapter'
import { platformAdapterRegistry } from '../platform-adapters/platform-adapter-registry'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import * as StoreManager from '../stores/store-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { waitForStoreWebContents } from '../browser/window-manager'
import { isAppLocked } from '../services/security-manager'

export interface PddOrderObservationRuntime {
  getStore: (storeId: string) => Store | null
  ensureSession: (storeId: string) => Promise<Session>
  getSessionStatus: (storeId: string) => ShopSessionStatusSummary
  /** 等店铺页面可用（含 DOM <webview> guest 注册）：页面现在由渲染层承载，开店后需要一点时间 */
  waitForStoreWebContents: (storeId: string) => Promise<WebContents | null>
  getAdapter: (platform: string) => PlatformAdapter | null
  detectLoginStatus: (storeId: string) => Promise<PlatformLoginResult>
  isLocked: () => boolean
}

function createDefaultRuntime(): PddOrderObservationRuntime {
  return {
    getStore: StoreManager.getStore,
    ensureSession: ShopSessionManager.ensureSession,
    getSessionStatus: ShopSessionManager.getSessionStatus,
    waitForStoreWebContents,
    getAdapter: platform => platformAdapterRegistry.resolveAdapter(platform),
    detectLoginStatus: detectStoreLoginStatus,
    isLocked: isAppLocked
  }
}

function assertStoreId(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) throw new Error('INVALID_ARGUMENT')
  return storeId.trim()
}

function isObservationCapable(adapter: PlatformAdapter | null): adapter is OrderObservationCapableAdapter {
  if (!adapter || !adapter.getCapabilities().orders) return false
  return typeof (adapter as Partial<OrderObservationCapableAdapter>).startOrderObservation === 'function' &&
    typeof (adapter as Partial<OrderObservationCapableAdapter>).stopOrderObservation === 'function'
}

function failedStart(storeId: string, reasonCode: string, safeMessage: string): PddOrderObservationStartResult {
  return {
    status: 'FAILED',
    storeId,
    platform: '拼多多',
    startedAt: null,
    expiresAt: null,
    reasonCode,
    safeMessage
  }
}

export class PddOrderObservationService {
  private readonly runtimeFactory: () => PddOrderObservationRuntime

  constructor(runtime?: PddOrderObservationRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  private get runtime(): PddOrderObservationRuntime { return this.runtimeFactory() }

  async start(storeIdInput: string, options: PddOrderObservationStartOptions): Promise<PddOrderObservationStartResult> {
    const storeId = assertStoreId(storeIdInput)
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const store = this.runtime.getStore(storeId)
    if (!store) throw new Error('STORE_NOT_FOUND')
    if (store.platform !== '拼多多') return failedStart(storeId, 'UNSUPPORTED_PLATFORM', '当前数据源发现阶段只支持拼多多')

    const adapter = this.runtime.getAdapter(store.platform)
    if (!isObservationCapable(adapter)) return failedStart(storeId, 'ADAPTER_NOT_FOUND', '拼多多观察 Adapter 不可用')

    let session: Session
    try {
      session = await this.runtime.ensureSession(storeId)
    } catch {
      return failedStart(storeId, 'SESSION_NOT_READY', '店铺 Session 尚未就绪')
    }
    const sessionStatus = this.runtime.getSessionStatus(storeId)
    if (sessionStatus.status !== 'READY' || !sessionStatus.sessionReady) {
      return failedStart(storeId, 'SESSION_NOT_READY', '店铺浏览器 Session 尚未就绪')
    }

    const webContents = await this.runtime.waitForStoreWebContents(storeId)
    if (!webContents || webContents.isDestroyed()) return failedStart(storeId, 'PAGE_NOT_READY', '请先打开拼多多店铺页面')
    try {
      if (webContents.session && webContents.session !== session) {
        return failedStart(storeId, 'SESSION_MISMATCH', '店铺浏览器 Session 不匹配，已拒绝观察')
      }
    } catch {
      return failedStart(storeId, 'SESSION_MISMATCH', '店铺浏览器 Session 不匹配，已拒绝观察')
    }

    const login = await this.runtime.detectLoginStatus(storeId)
    if (login.status === 'LOGIN_REQUIRED' || login.status === 'VERIFY_REQUIRED' || login.status === 'ERROR') {
      return failedStart(storeId, login.status, login.safeMessage)
    }

    return adapter.startOrderObservation({
      storeId,
      platform: store.platform,
      session,
      webContents,
      currentUrl: this.readUrl(webContents),
      timeoutMs: options.timeoutMs
    }, options)
  }

  async stop(storeIdInput: string): Promise<PddOrderObservationStopResult> {
    const storeId = assertStoreId(storeIdInput)
    if (this.runtime.isLocked()) throw new Error('APP_LOCKED')
    const store = this.runtime.getStore(storeId)
    if (!store) throw new Error('STORE_NOT_FOUND')
    if (store.platform !== '拼多多') {
      return {
        status: 'FAILED',
        storeId,
        platform: '拼多多',
        report: null,
        reasonCode: 'UNSUPPORTED_PLATFORM',
        safeMessage: '当前数据源发现阶段只支持拼多多'
      }
    }
    const adapter = this.runtime.getAdapter(store.platform)
    if (!isObservationCapable(adapter)) {
      return {
        status: 'FAILED',
        storeId,
        platform: '拼多多',
        report: null,
        reasonCode: 'ADAPTER_NOT_FOUND',
        safeMessage: '拼多多观察 Adapter 不可用'
      }
    }
    return adapter.stopOrderObservation(storeId)
  }

  private readUrl(webContents: WebContents): string {
    try { return String(webContents.getURL() || '') } catch { return '' }
  }
}

export const pddOrderObservationService = new PddOrderObservationService()
