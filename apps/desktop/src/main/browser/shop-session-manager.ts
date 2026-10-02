/**
 * 店铺 Session 统一 Facade。
 *
 * 本模块不创建第二套浏览器系统，也不重新实现 Electron Session。
 * 底层 Session、代理、权限、下载和 Cookie 快照仍由现有模块负责；
 * 这里仅统一店铺校验、生命周期协调和安全的状态摘要。
 */

import { session as electronSession } from 'electron'
import type { Session } from 'electron'
import { getDatabase } from '../db/database'
import {
  closeStoreSession as closeUnderlyingStoreSession,
  getActiveSessions,
  getStorePartition,
  getProxyAuthInjection,
  getStoreSession as getUnderlyingStoreSession,
  waitForStoreSessionReady
} from './session-manager'
import { clearStoreSessionSnapshot } from '../services/session-persistence'
import {
  SHOP_SESSION_STATUS_CODES,
  SHOP_SESSION_LOGIN_STATUSES,
  type ShopSessionStatusCode,
  type ShopSessionStatusSummary
} from '@shared/contracts/shop-session'
import { PLATFORM_EVIDENCE_TYPES, type PlatformLoginResult } from '@shared/contracts/platform-adapter'

const statusByStore = new Map<string, ShopSessionStatusSummary>()

function assertStoreIdInput(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) {
    throw new Error('INVALID_ARGUMENT: storeId 无效')
  }
  return storeId.trim()
}

/**
 * 默认只允许访问未删除店铺；destroy 场景在物理删除数据库行前允许访问回收站店铺。
 */
function assertStoreExists(storeId: string, includeDeleted = false): string {
  const id = assertStoreIdInput(storeId)
  const db = getDatabase()
  const sql = includeDeleted
    ? 'SELECT id FROM stores WHERE id = ?'
    : 'SELECT id FROM stores WHERE id = ? AND deleted_at IS NULL'
  const row = db.prepare(sql).get(id) as { id?: string } | undefined
  if (!row?.id) throw new Error('STORE_NOT_FOUND')
  return id
}

function emptyStatus(storeId: string, sessionPresent = false): ShopSessionStatusSummary {
  return {
    storeId,
    status: 'UNKNOWN',
    sessionPresent,
    sessionReady: false,
    healthy: null,
    // Session 存在不能推断平台登录成功；平台适配器检测通过独立方法写入摘要。
    loginStatus: 'UNKNOWN',
    platform: null,
    lastCheckedAt: null,
    loginCheckedAt: null,
    loginReasonCode: null,
    loginSafeMessage: null,
    loginEvidenceType: null,
    proxyAuthObserved: false,
    errorCode: null
  }
}

function statusFor(storeId: string): ShopSessionStatusSummary {
  const current = statusByStore.get(storeId)
  const active = getActiveSessions().has(storeId)

  // 底层 Session 可能在旧调用路径中被关闭；不要向 Renderer 返回过期的 READY。
  if (!active && current && current.sessionPresent) {
    const next = emptyStatus(storeId, false)
    statusByStore.set(storeId, next)
    return next
  }

  if (!current) {
    const next = emptyStatus(storeId, active)
    statusByStore.set(storeId, next)
    return next
  }
  return {
    ...current,
    sessionPresent: active || current.sessionPresent,
    // 只回传是否发生过成功处理，不把代理用户名、时间戳或凭据带到 Renderer。
    proxyAuthObserved: Boolean(getProxyAuthInjection(storeId))
  }
}

function setStatus(
  storeId: string,
  status: ShopSessionStatusCode,
  patch: Partial<Omit<ShopSessionStatusSummary, 'storeId' | 'status'>> = {}
): ShopSessionStatusSummary {
  // 只接受公开状态枚举，防止内部调用误把异常字符串带到 IPC。
  if (!SHOP_SESSION_STATUS_CODES.includes(status)) {
    status = 'ERROR'
  }
  const next: ShopSessionStatusSummary = {
    ...emptyStatus(storeId, getActiveSessions().has(storeId)),
    ...statusByStore.get(storeId),
    ...patch,
    storeId,
    status
  }
  statusByStore.set(storeId, next)
  return next
}

function markChecking(storeId: string): ShopSessionStatusSummary {
  return setStatus(storeId, 'CHECKING', {
    sessionPresent: true,
    sessionReady: false,
    healthy: null,
    loginStatus: 'UNKNOWN',
    platform: null,
    loginCheckedAt: null,
    loginReasonCode: null,
    loginSafeMessage: null,
    loginEvidenceType: null,
    errorCode: null
  })
}

function markReady(storeId: string): ShopSessionStatusSummary {
  return setStatus(storeId, 'READY', {
    sessionPresent: true,
    sessionReady: true,
    healthy: true,
    // Session 就绪不代表平台登录；新建/恢复 Session 后等待独立适配器检测。
    loginStatus: 'UNKNOWN',
    platform: null,
    loginCheckedAt: null,
    loginReasonCode: null,
    loginSafeMessage: null,
    loginEvidenceType: null,
    lastCheckedAt: Date.now(),
    errorCode: null
  })
}

function markError(storeId: string): ShopSessionStatusSummary {
  return setStatus(storeId, 'ERROR', {
    sessionPresent: getActiveSessions().has(storeId),
    sessionReady: false,
    healthy: false,
    loginStatus: 'UNKNOWN',
    platform: null,
    loginCheckedAt: null,
    loginReasonCode: null,
    loginSafeMessage: null,
    loginEvidenceType: null,
    lastCheckedAt: Date.now(),
    errorCode: 'SESSION_ERROR'
  })
}

/** 仅允许 Main Process 使用，Renderer 永远拿不到 Electron Session 引用。 */
export function getSession(storeId: string): Session {
  const id = assertStoreExists(storeId)
  try {
    const current = statusByStore.get(id)
    if (!current || current.status === 'UNKNOWN' || current.status === 'ERROR') markChecking(id)
    return getUnderlyingStoreSession(id)
  } catch (error) {
    markError(id)
    throw error
  }
}

/** 创建/配置店铺 Session，并等待现有底层代理和 Profile 配置完成。 */
export async function ensureSession(storeId: string): Promise<Session> {
  const id = assertStoreExists(storeId)
  try {
    const current = getSession(id)
    await waitForStoreSessionReady(id)
    markReady(id)
    return current
  } catch (error) {
    markError(id)
    throw error
  }
}

/** 供已有 WebContentsView 首次导航复用，保持原有等待语义并更新状态。 */
export async function waitForSessionReady(storeId: string): Promise<void> {
  const id = assertStoreExists(storeId)
  try {
    await waitForStoreSessionReady(id)
    markReady(id)
  } catch (error) {
    markError(id)
    throw error
  }
}

/**
 * 检查 Session 本身是否可用。
 * 这里不做平台登录判断；平台登录检测由 platform-login-service 独立协调。
 */
export async function checkSessionHealth(storeId: string): Promise<ShopSessionStatusSummary> {
  const id = assertStoreExists(storeId)
  markChecking(id)
  try {
    await ensureSession(id)
  } catch {
    return getSessionStatus(id)
  }
  return getSessionStatus(id)
}

/** 返回给 IPC/Renderer 的安全摘要，不包含 Session、partition、Cookie 或 Token。 */
export function getSessionStatus(storeId: string): ShopSessionStatusSummary {
  const id = assertStoreExists(storeId)
  return { ...statusFor(id) }
}

/**
 * 返回已存在店铺的平台标识，平台值沿用 stores.platform 原值，不建立第二套枚举。
 * 仅供 Main 进程平台适配服务使用。
 */
export function getStorePlatform(storeId: string): string {
  const id = assertStoreExists(storeId)
  const row = getDatabase().prepare('SELECT platform FROM stores WHERE id = ? AND deleted_at IS NULL').get(id) as
    { platform?: unknown } | undefined
  if (typeof row?.platform !== 'string' || !row.platform.trim()) throw new Error('STORE_NOT_FOUND')
  return row.platform
}

const SAFE_LOGIN_MESSAGES: Record<PlatformLoginResult['status'], string> = {
  UNKNOWN: '无法确认平台登录状态',
  LOGGED_IN: '平台登录状态已确认',
  LOGIN_REQUIRED: '需要在店铺浏览器中登录',
  VERIFY_REQUIRED: '需要在店铺浏览器中完成安全验证',
  ERROR: '平台登录状态检测失败'
}

/**
 * 仅供 Main 内部平台适配服务写入内存中的安全登录摘要。
 * 再次校验店铺、平台和 Session READY，防止迟到的检测结果或跨店铺结果写入。
 */
export function recordPlatformLoginResult(input: PlatformLoginResult): PlatformLoginResult {
  const id = assertStoreExists(input?.storeId)
  const platform = getStorePlatform(id)
  const current = statusFor(id)
  const sessionReady = current.status === 'READY' && current.sessionReady && getActiveSessions().has(id)
  const requestedStatus = SHOP_SESSION_LOGIN_STATUSES.includes(input.status) ? input.status : 'ERROR'
  const status = sessionReady ? requestedStatus : 'UNKNOWN'
  const evidenceType = PLATFORM_EVIDENCE_TYPES.includes(input.evidenceType) ? input.evidenceType : 'NONE'
  const reasonCode = sessionReady && /^[A-Z0-9_]{1,64}$/.test(String(input.reasonCode))
    ? input.reasonCode
    : sessionReady ? 'ADAPTER_ERROR' : 'SESSION_NOT_READY'
  const checkedAt = Number.isFinite(input.checkedAt) ? input.checkedAt : Date.now()
  const result: PlatformLoginResult = {
    platform,
    storeId: id,
    status,
    checkedAt,
    reasonCode,
    // 不信任平台页面文本或 Adapter 异常文本作为 IPC 消息。
    safeMessage: SAFE_LOGIN_MESSAGES[status],
    evidenceType: status === 'UNKNOWN' && reasonCode === 'SESSION_NOT_READY' ? 'NONE' : evidenceType
  }

  statusByStore.set(id, {
    ...current,
    platform,
    loginStatus: result.status,
    loginCheckedAt: result.checkedAt,
    loginReasonCode: result.reasonCode,
    loginSafeMessage: result.safeMessage,
    loginEvidenceType: result.evidenceType
  })
  return result
}

export interface CloseStoreSessionOptions {
  /** 删除店铺时设为 false，避免关闭流程重新写入会话 Cookie 快照。 */
  preserveLogin?: boolean
  /** 回收站店铺仍允许被清理；普通调用不能访问已删除店铺。 */
  allowDeleted?: boolean
}

/**
 * 关闭当前 Session 引用，但不清 Cookie、不删 Profile、不删 partition。
 */
export function closeStoreSession(storeId: string, options: CloseStoreSessionOptions = {}): void {
  const id = assertStoreExists(storeId, options.allowDeleted === true)
  closeUnderlyingStoreSession(id, { persist: options.preserveLogin !== false })
  statusByStore.set(id, emptyStatus(id, false))
}

/**
 * 彻底清理店铺 Session 数据，仅用于真实删除店铺等场景。
 * 数据库中的 stores/browser_profiles 记录由 StoreManager 按现有级联流程处理。
 */
export async function destroyStoreSession(storeId: string): Promise<void> {
  const id = assertStoreExists(storeId, true)
  // 不再写入会话快照，避免清理后异步快照把旧登录态写回来。
  closeUnderlyingStoreSession(id, { persist: false })
  const storeSession = electronSession.fromPartition(getStorePartition(id), { cache: true })
  await storeSession.clearStorageData()
  clearStoreSessionSnapshot(id)
  statusByStore.delete(id)
}

export function hasActiveSession(storeId: string): boolean {
  const id = assertStoreIdInput(storeId)
  return getActiveSessions().has(id)
}

/** 测试和应用退出清理使用；不暴露任何 Session 内容。 */
export function resetSessionStatusForTests(): void {
  statusByStore.clear()
}
