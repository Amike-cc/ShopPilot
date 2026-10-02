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
import { StoreStatus } from '@shared/enums/store-status'
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
 * 登录检测结果 → 店铺状态。返回 null = **不改状态**。
 *
 * 为什么 UNKNOWN / ERROR 不改状态：这两种是"这次没拿到证据"（页面还没渲染、当前标签页
 * 不是档案页、检测超时、适配器报错），**不是**"确认未登录"。以前这里把非 LOGGED_IN 一律
 * 写成 offline，于是出现两类假离线（2026-09-30 实测）：
 *   · 正常页面上检测恒返回 UNKNOWN（适配器缺正向证据）→ 登录成功后仍永久显示离线；
 *   · 刚登录好的店铺一旦切到没有经营数据锚点的页面（如发票页）→ 立刻被打回离线。
 * 没证据就保持上一次已确认的结论。
 *
 * 为什么明确的否定证据要写 `needs_login` 而**不是** `offline`（2026-10-02 修）：
 * `offline` 在整套语义里是"**浏览器窗口没开 / 还没确认登录**"，不是"确认没登录"——
 * 这一点是产品其它地方明确定义并依赖的（`product-publish-rules.precheckPublish` 里
 * `offline`/`launching` 只记 warning，而 `needs_login` 才阻断发布；`docs/DEVELOPMENT_SPEC.md`
 * §9.1 的状态机也写着 `launching -> needs_login` / `online -> needs_login` / `needs_login -> online`）。
 * 此前这里把两种否定证据都塌成 `offline`，于是 `StoreStatus.NEEDS_LOGIN` **在整个代码库里
 * 一个生产者都没有**，后果是登录已失效的店铺：
 *   · 店铺卡/侧栏显示成灰色「离线」，和"窗口没开"长得一模一样，看不出要重新登录；
 *   · 概览页 `hasLoginIssue`（只认 `needs_login`）恒为 false → 登录失效永远不上报；
 *   · 发布预检里 `needs_login` 的阻断项永不触发 → 明明登录失效仍被放行到后续步骤。
 *
 * VERIFY_REQUIRED（平台要求安全验证）同样落到 `needs_login`：它和"登录失效"一样是
 * "需要用户回店铺浏览器处理"的明确否定证据，状态枚举里没有更贴切的值，而发布/采集
 * 都必须停在这里等人处理，不能当成"只是窗口没开"放过去。
 */
export function storeStatusForLoginResult(status: PlatformLoginStatus): StoreStatus | null {
  if (status === 'LOGGED_IN') return StoreStatus.ONLINE
  if (status === 'LOGIN_REQUIRED' || status === 'VERIFY_REQUIRED') return StoreStatus.NEEDS_LOGIN
  return null
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
  const promise = runDetection(storeId, runtime, registry, timeoutMs).then(result => {
    // 只有**明确的**证据才改店铺状态：确认登录 → online；确认是登录页/验证页 → needs_login。
    // 没拿到证据（UNKNOWN/ERROR）不改——理由见 storeStatusForLoginResult 的注释。
    // 仅默认运行时落库，测试运行时不触碰 DB。
    if (useDedupe) {
      const nextStatus = storeStatusForLoginResult(result.status)
      if (nextStatus) StoreManager.updateStoreStatus(storeId, nextStatus)
    }
    return result
  })
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
