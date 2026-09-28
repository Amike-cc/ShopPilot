/**
 * 店铺 Session 的安全摘要契约。
 *
 * 这里故意不包含 Electron Session、partition、Cookie、Token 或存储内容。
 * 该类型可以跨 IPC 使用，但不能把主进程内部的敏感引用带到 Renderer。
 */

export const SHOP_SESSION_STATUS_CODES = [
  'UNKNOWN',
  'READY',
  'CHECKING',
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'ERROR'
] as const

export type ShopSessionStatusCode = typeof SHOP_SESSION_STATUS_CODES[number]

import type { PlatformEvidenceType } from './platform-adapter'

/**
 * Session 就绪与平台登录是两条独立状态轴。
 * Session READY 只代表 Electron Session 可用，不代表平台已经登录。
 */
export const SHOP_SESSION_LOGIN_STATUSES = [
  'UNKNOWN',
  'LOGGED_IN',
  'LOGIN_REQUIRED',
  'VERIFY_REQUIRED',
  'ERROR'
] as const

export type ShopSessionLoginStatus = typeof SHOP_SESSION_LOGIN_STATUSES[number]

export interface ShopSessionStatusSummary {
  storeId: string
  status: ShopSessionStatusCode
  sessionPresent: boolean
  sessionReady: boolean
  /** Session 配置/连通性是否正常；null 表示还没有检查。 */
  healthy: boolean | null
  /** 没有平台适配器时必须保持 UNKNOWN。 */
  loginStatus: ShopSessionLoginStatus
  /** 店铺当前使用的平台名；未知或尚未完成平台检测时为 null。 */
  platform: string | null
  lastCheckedAt: number | null
  /** 平台登录检测的时间和安全诊断摘要；不包含页面原文或认证数据。 */
  loginCheckedAt: number | null
  loginReasonCode: string | null
  loginSafeMessage: string | null
  loginEvidenceType: PlatformEvidenceType | null
  /** 只返回稳定错误码，不返回底层异常原文。 */
  errorCode: 'SESSION_ERROR' | null
}
