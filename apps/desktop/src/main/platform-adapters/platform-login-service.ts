import type { Session, WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import type {
  PlatformLoginResult,
  PlatformLoginStatus,
  PlatformEvidenceType
} from '@shared/contracts/platform-adapter'
import type { ShopSessionStatusSummary } from '@shared/contracts/shop-session'
import * as StoreManager from '../stores/store-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import {
  getActiveTabId,
  getCurrentStoreWebContents,
  getTabWebContents
} from '../browser/window-manager'
import { logMain } from '../services/logger'
import {
  platformAdapterRegistry,
  type PlatformAdapterRegistry
} from './platform-adapter-registry'
import type { PlatformAdapterContext } from './platform-adapter'

export const DEFAULT_LOGIN_DETECTION_TIMEOUT_MS = 5000

export interface PlatformAdapterRuntime {
  getStore: (storeId: string) => Store | null
  ensureSession: (storeId: string) => Promise<Session>
  getSessionStatus: (storeId: string) => ShopSessionStatusSummary
  getActiveTabId: (storeId: string) => string | null
  getTabWebContents: (storeId: string, tabId: string) => WebContents | null
  getCurrentStoreWebContents: (storeId: string) => WebContents | null
  recordPlatformLoginResult: (result: PlatformLoginResult) => PlatformLoginResult
}

const defaultRuntime: PlatformAdapterRuntime = {
  getStore: StoreManager.getStore,
  ensureSession: ShopSessionManager.ensureSession,
  getSessionStatus: ShopSessionManager.getSessionStatus,
  getActiveTabId,
  getTabWebContents,
  getCurrentStoreWebContents,
  recordPlatformLoginResult: ShopSessionManager.recordPlatformLoginResult
}

const resultCache = new Map<string, PlatformLoginResult>()
const inFlight = new Map<string, Promise<PlatformLoginResult>>()

function assertStoreId(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) {
    throw new Error('INVALID_ARGUMENT: storeId 无效')
  }
  return storeId.trim()
}

function messageFor(status: PlatformLoginStatus): string {
  return {
    UNKNOWN: '无法确认平台登录状态',
    LOGGED_IN: '平台登录状态已确认',
    LOGIN_REQUIRED: '需要在店铺浏览器中登录',
    VERIFY_REQUIRED: '需要在店铺浏览器中完成安全验证',
    ERROR: '平台登录状态检测失败'
  }[status]
}

function isLoginStatus(value: unknown): value is PlatformLoginStatus {
  return value === 'UNKNOWN' || value === 'LOGGED_IN' || value === 'LOGIN_REQUIRED' ||
    value === 'VERIFY_REQUIRED' || value === 'ERROR'
}

function isEvidenceType(value: unknown): value is PlatformEvidenceType {
  return value === 'URL' || value === 'DOM' || value === 'NETWORK' || value === 'COMBINED' || value === 'NONE'
}

function normalizeResult(
  raw: PlatformLoginResult,
  storeId: string,
  platform: string,
  fallbackStatus: PlatformLoginStatus = 'UNKNOWN'
): PlatformLoginResult {
  const status = isLoginStatus(raw?.status) ? raw.status : fallbackStatus
  const reasonCode = /^[A-Z0-9_]{1,64}$/.test(String(raw?.reasonCode || ''))
    ? String(raw.reasonCode)
    : 'DETECTION_FAILED'
  const safeMessage = messageFor(status)
  return {
    platform,
    storeId,
    status,
    checkedAt: Number.isFinite(raw?.checkedAt) ? Number(raw.checkedAt) : Date.now(),
    reasonCode,
    safeMessage,
    evidenceType: isEvidenceType(raw?.evidenceType) ? raw.evidenceType : 'NONE'
  }
}

function resultFor(
  storeId: string,
  platform: string,
  status: PlatformLoginStatus,
  reasonCode: string,
  evidenceType: PlatformEvidenceType = 'NONE'
): PlatformLoginResult {
  return normalizeResult({
    platform,
    storeId,
    status,
    checkedAt: Date.now(),
    reasonCode,
    safeMessage: messageFor(status),
    evidenceType
  }, storeId, platform, status)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const safeTimeout = Math.max(1, Math.min(Math.floor(timeoutMs), 30000))
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DETECTION_TIMEOUT')), safeTimeout)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function currentUrlOf(webContents: WebContents): string {
  try { return String(webContents.getURL() || '') } catch { return '' }
}

function selectedWebContents(runtime: PlatformAdapterRuntime, storeId: string): WebContents | null {
  const tabId = runtime.getActiveTabId(storeId)
  if (tabId) {
    const tabContents = runtime.getTabWebContents(storeId, tabId)
    if (tabContents) return tabContents
  }
  return runtime.getCurrentStoreWebContents(storeId)
}

async function runDetection(
  storeId: string,
  runtime: PlatformAdapterRuntime,
  registry: PlatformAdapterRegistry,
  timeoutMs: number
): Promise<PlatformLoginResult> {
  const startedAt = Date.now()
  const store = runtime.getStore(storeId)
  if (!store) throw new Error('STORE_NOT_FOUND')

  const adapter = registry.resolveAdapter(store.platform)
  if (!adapter) {
    const unsupported = resultFor(storeId, store.platform, 'ERROR', 'UNSUPPORTED_PLATFORM')
    safelyRecord(runtime, unsupported)
    logResult('none', storeId, store.platform, startedAt, unsupported)
    return unsupported
  }

  let session: Session
  try {
    session = await runtime.ensureSession(storeId)
  } catch {
    const notReady = resultFor(storeId, store.platform, 'UNKNOWN', 'SESSION_NOT_READY')
    safelyRecord(runtime, notReady)
    logResult(adapter.adapterName, storeId, store.platform, startedAt, notReady)
    return notReady
  }

  let sessionStatus: ShopSessionStatusSummary
  try { sessionStatus = runtime.getSessionStatus(storeId) } catch {
    const notReady = resultFor(storeId, store.platform, 'UNKNOWN', 'SESSION_NOT_READY')
    safelyRecord(runtime, notReady)
    logResult(adapter.adapterName, storeId, store.platform, startedAt, notReady)
    return notReady
  }
  if (sessionStatus.status !== 'READY' || !sessionStatus.sessionReady) {
    const notReady = resultFor(storeId, store.platform, 'UNKNOWN', 'SESSION_NOT_READY')
    safelyRecord(runtime, notReady)
    logResult(adapter.adapterName, storeId, store.platform, startedAt, notReady)
    return notReady
  }

  const webContents = selectedWebContents(runtime, storeId)
  if (!webContents || webContents.isDestroyed()) {
    const pageNotReady = resultFor(storeId, store.platform, 'UNKNOWN', 'PAGE_NOT_READY')
    safelyRecord(runtime, pageNotReady)
    logResult(adapter.adapterName, storeId, store.platform, startedAt, pageNotReady)
    return pageNotReady
  }
  // Electron WebContents 自带的 Session 必须与当前店铺 Facade 返回的 Session 相同；
  // 任何跨店铺句柄都在进入 Adapter 前拒绝，避免把另一店铺页面当作当前店铺证据。
  try {
    if (webContents.session && webContents.session !== session) {
      const mismatch = resultFor(storeId, store.platform, 'ERROR', 'SESSION_MISMATCH')
      safelyRecord(runtime, mismatch)
      logResult(adapter.adapterName, storeId, store.platform, startedAt, mismatch)
      return mismatch
    }
  } catch {
    const mismatch = resultFor(storeId, store.platform, 'ERROR', 'SESSION_MISMATCH')
    safelyRecord(runtime, mismatch)
    logResult(adapter.adapterName, storeId, store.platform, startedAt, mismatch)
    return mismatch
  }

  const context: PlatformAdapterContext = {
    storeId,
    platform: store.platform,
    session,
    webContents,
    currentUrl: currentUrlOf(webContents),
    timeoutMs
  }

  let result: PlatformLoginResult
  try {
    const raw = await withTimeout(adapter.detectLoginStatus(context), timeoutMs)
    result = normalizeResult(raw, storeId, store.platform)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reasonCode = message.includes('DETECTION_TIMEOUT')
      ? 'DETECTION_TIMEOUT'
      : 'ADAPTER_ERROR'
    result = resultFor(storeId, store.platform, reasonCode === 'DETECTION_TIMEOUT' ? 'UNKNOWN' : 'ERROR', reasonCode)
  }

  safelyRecord(runtime, result)
  logResult(adapter.adapterName, storeId, store.platform, startedAt, result)
  return result
}

function safelyRecord(runtime: PlatformAdapterRuntime, result: PlatformLoginResult): void {
  try {
    const recorded = runtime.recordPlatformLoginResult(result)
    resultCache.set(result.storeId, recorded)
  } catch (error) {
    // 状态写入失败不能让某个平台检测异常扩散到主进程或其它店铺。
    logMain('warn', `[platform-adapter] record failed storeId=${result.storeId} reasonCode=DETECTION_FAILED`)
  }
}

function logResult(
  adapter: string,
  storeId: string,
  platform: string,
  startedAt: number,
  result: PlatformLoginResult
): void {
  logMain('info', `[platform-adapter] ${JSON.stringify({
    platform,
    storeId,
    adapter,
    operation: 'detectLoginStatus',
    duration: Date.now() - startedAt,
    result: result.status,
    reasonCode: result.reasonCode
  })}`)
}

/**
 * 检测某店铺当前页面的登录摘要。检测只使用该店铺 Session 与当前标签页，
 * 不接受 partition、Session 或页面对象来自 Renderer 的输入。
 */
export function detectStoreLoginStatus(
  rawStoreId: string,
  options: {
    runtime?: PlatformAdapterRuntime
    registry?: PlatformAdapterRegistry
    timeoutMs?: number
  } = {}
): Promise<PlatformLoginResult> {
  const storeId = assertStoreId(rawStoreId)
  const runtime = options.runtime || defaultRuntime
  const registry = options.registry || platformAdapterRegistry
  const timeoutMs = options.timeoutMs || DEFAULT_LOGIN_DETECTION_TIMEOUT_MS
  const useDedupe = !options.runtime && !options.registry
  if (useDedupe) {
    const current = inFlight.get(storeId)
    if (current) return current
  }
  const promise = runDetection(storeId, runtime, registry, timeoutMs)
  if (!useDedupe) return promise
  inFlight.set(storeId, promise)
  return promise.finally(() => {
    if (inFlight.get(storeId) === promise) inFlight.delete(storeId)
  })
}

export function getCachedPlatformLoginStatus(storeId: string): PlatformLoginResult | null {
  const id = assertStoreId(storeId)
  const cached = resultCache.get(id)
  if (!cached) return null
  const store = defaultRuntime.getStore(id)
  if (!store) {
    resultCache.delete(id)
    return null
  }
  let session: ShopSessionStatusSummary
  try { session = defaultRuntime.getSessionStatus(id) } catch {
    resultCache.delete(id)
    return null
  }
  if (store.platform !== cached.platform || session.status !== 'READY' || !session.sessionReady) {
    resultCache.delete(id)
    return null
  }
  return { ...cached }
}

export function resetPlatformLoginCacheForTests(): void {
  resultCache.clear()
  inFlight.clear()
}
