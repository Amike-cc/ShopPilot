/**
 * 平台登录适配层的安全返回契约。
 *
 * 这里只放可以跨 IPC 传递的状态摘要。Electron Session、WebContents、Cookie、Token
 * 和完整网络凭据都属于 Main 进程内部对象，不能出现在本契约中。
 */

export const PLATFORM_LOGIN_STATUSES = [
  'UNKNOWN',
  'LOGGED_IN',
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'ERROR'
] as const

export type PlatformLoginStatus = typeof PLATFORM_LOGIN_STATUSES[number]

export const PLATFORM_EVIDENCE_TYPES = [
  'URL',
  'DOM',
  'NETWORK',
  'COMBINED',
  'NONE'
] as const

export type PlatformEvidenceType = typeof PLATFORM_EVIDENCE_TYPES[number]

export const PLATFORM_ADAPTER_ERROR_CODES = [
  'ADAPTER_NOT_FOUND',
  'UNSUPPORTED_PLATFORM',
  'SESSION_NOT_READY',
  'PAGE_NOT_READY',
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'DETECTION_TIMEOUT',
  'DETECTION_FAILED',
  'ADAPTER_ERROR',
  'DETECTION_EVIDENCE_INSUFFICIENT',
  'SESSION_MISMATCH',
  'EXPLICIT_LOGIN_PAGE',
  'PAGE_NOT_RECOGNIZED'
] as const

export type PlatformAdapterErrorCode = typeof PLATFORM_ADAPTER_ERROR_CODES[number]

import type {
  OrderCollectionStatus,
  OrderDataSource,
  UnifiedOrder
} from './unified-order'
import type {
  PddOrderObservationReport,
  PddOrderObservationStartOptions
} from './pdd-order-observation'

/** 适配器能力只描述当前真实实现边界；未实现能力必须保持 false。 */
export interface PlatformAdapterCapabilities {
  loginDetection: boolean
  orders: boolean
  salesMetrics: boolean
  productSalesMetrics: boolean
  products: boolean
  inventory: boolean
  refunds: boolean
  salesData: boolean
}


export interface PlatformOrderCollectionOptions {
  maxPages: number
  maxOrders: number
  timeoutMs: number
}

/** 观察阶段只返回安全报告，不返回响应正文。 */
export type PlatformOrderObservationOptions = PddOrderObservationStartOptions

/** Adapter 返回给 Main Service 的订单采集结果，不包含 Cookie/Token/Header。 */
export interface PlatformOrderCollectionResult {
  status: Exclude<OrderCollectionStatus, 'ALREADY_RUNNING'>
  source: OrderDataSource
  orders: UnifiedOrder[]
  fetchedCount: number
  skippedCount: number
  observedResponseCount: number
  nextCursor: string | null
  hasMore: boolean
  reasonCode: string
  safeMessage: string
  observationReport?: PddOrderObservationReport
}


/**
 * 平台登录检测的安全结果。
 * reasonCode 是稳定的诊断码；safeMessage 面向用户，不能包含页面原文或认证数据。
 */
export interface PlatformLoginResult {
  platform: string
  storeId: string
  status: PlatformLoginStatus
  checkedAt: number
  reasonCode: string
  safeMessage: string
  evidenceType: PlatformEvidenceType
}
