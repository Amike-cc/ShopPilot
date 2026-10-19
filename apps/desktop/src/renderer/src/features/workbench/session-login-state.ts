/**
 * 「主动检测登录状态」的**纯逻辑**（2026-10-18）。
 *
 * 缺口背景：`session.checkLoginStatus`（IPC + preload + 类型）全链路齐全，渲染层却
 * 零调用——用户只能看到被动会话摘要，没有任何"主动查一次登录态"的入口；同时
 * `EVENT_CHANNELS.SESSION_EXPIRED` 主进程 0 emit、渲染层 0 订阅，是一条死契约。
 * 这里把与界面无关的判断集中起来：
 *   · IPC 返回的 `PlatformLoginResult` / `ShopSessionStatusSummary` → 可上屏的中文结论；
 *   · 按钮文案与"什么时候允许检测"。
 * 零 vue / electron / DOM 依赖。
 *
 * 一条硬原则：**拿不到证据就说拿不到**。主进程的 UNKNOWN 表示"这次没拿到证据"
 * （页面没开、当前标签页不是档案页、检测超时…），不是"未登录"；结构不认识时更不能
 * 顺着默认值说"已登录"。所以：只有明确的 LOGIN_REQUIRED 才判 `expired`，
 * UNKNOWN / 结构不认识一律按「未识别」如实上屏。
 */

import type { PlatformLoginResult, PlatformLoginStatus } from '@shared/contracts/platform-adapter'
import type { ShopSessionStatusSummary } from '@shared/contracts/shop-session'

export type LoginCheckTone = 'success' | 'warning' | 'error' | 'info'

/** 直接驱动会话块那一行：tone → 颜色类，label + detail 上屏。 */
export interface LoginCheckView {
  tone: LoginCheckTone
  label: string
  detail: string
  /**
   * 登录态**不可用**（未登录 / 已过期）：与主进程 emit `SESSION_EXPIRED` 的触发条件一致。
   * 只有明确的 LOGIN_REQUIRED 才为 true——UNKNOWN / ERROR / VERIFY_REQUIRED 都不是"过期"。
   */
  expired: boolean
}

/** 检测按钮的门控输入：三项都来自渲染层已有的状态。 */
export interface LoginCheckGateInput {
  storeId?: string | null
  /** 店铺页面（活动标签的 webview guest）是否已经挂载——没挂载时检测只会得到 UNKNOWN。 */
  pageAttached?: boolean
  appLocked?: boolean
}

/**
 * `session.checkLoginStatus` 成功返回的形状：会话摘要（ShopSessionStatusSummary）+ 平台登录结果。
 * `describeLoginCheckResult` 收的是 unknown——这两种形状都认，认不出来就如实说「未识别」。
 */
export type LoginCheckPayload = Partial<ShopSessionStatusSummary> & { platformLogin?: Partial<PlatformLoginResult> | null }

const KNOWN_LOGIN_STATUSES: readonly PlatformLoginStatus[] = ['UNKNOWN', 'LOGGED_IN', 'LOGIN_REQUIRED', 'VERIFY_REQUIRED', 'ERROR']

/** 主进程没给 safeMessage 时的兜底文案（与 platform-login-service 的 messageFor 口径一致）。 */
const FALLBACK_MESSAGE: Record<PlatformLoginStatus, string> = {
  UNKNOWN: '无法确认平台登录状态',
  LOGGED_IN: '平台登录状态已确认',
  LOGIN_REQUIRED: '需要在店铺浏览器中登录',
  VERIFY_REQUIRED: '需要在店铺浏览器中完成安全验证',
  ERROR: '平台登录状态检测失败'
}

function isKnownStatus(value: unknown): value is PlatformLoginStatus {
  return typeof value === 'string' && (KNOWN_LOGIN_STATUSES as readonly string[]).includes(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 从任意形状里挑出可用的登录信号；挑不出来返回 null（= 结构不认识）。 */
function readLoginSignal(result: unknown): { status: PlatformLoginStatus; reasonCode: string; safeMessage: string; sessionPresent: boolean | null } | null {
  const root = asRecord(result)
  if (!root) return null
  const sessionPresent = typeof root.sessionPresent === 'boolean' ? root.sessionPresent : null

  // ① 首选 platformLogin（PlatformLoginResult 的真实字段）
  const platformLogin = asRecord(root.platformLogin)
  if (platformLogin && isKnownStatus(platformLogin.status)) {
    return {
      status: platformLogin.status,
      reasonCode: readText(platformLogin.reasonCode),
      safeMessage: readText(platformLogin.safeMessage),
      sessionPresent
    }
  }

  // ② 退化：直接返回会话摘要时，只有 `loginStatus` 是登录轴。
  //    绝不用 `status`：它是 **Session 就绪轴**，两条轴共享 UNKNOWN / LOGIN_REQUIRED /
  //    VERIFY_REQUIRED / ERROR 四个取值，拿它推登录结论会把「会话要求重新登录」误报成
  //    「登录态已过期」（2026-10-18 独立复验 F4）。拿不到登录轴证据就说「未识别」。
  const summaryStatus = isKnownStatus(root.loginStatus) ? root.loginStatus : null
  if (!summaryStatus) return null
  return {
    status: summaryStatus,
    reasonCode: readText(root.loginReasonCode) || readText(root.reasonCode),
    safeMessage: readText(root.loginSafeMessage) || readText(root.safeMessage),
    sessionPresent
  }
}

/** 诊断码跟在文案后面，便于用户报障时对上主进程日志；没有就不加括号。 */
function withCode(message: string, reasonCode: string): string {
  return reasonCode ? `${message}（${reasonCode}）` : message
}

/**
 * 检测结果 → 可直接上屏的结论。
 *
 * 覆盖：已登录 / 未登录 / 登录态过期 / 需要安全验证 / 检测失败 / 未识别（结构不认识）。
 * 「过期」与「未登录」的区分用会话摘要里的 `sessionPresent`：本来有会话、现在平台要求
 * 重新登录 = 过期；从来没有会话 = 未登录。摘要里没有这个字段时不猜，按「未登录」说。
 */
export function describeLoginCheckResult(result: unknown): LoginCheckView {
  const signal = readLoginSignal(result)
  if (!signal) {
    return {
      tone: 'info',
      label: '未识别',
      detail: '主进程返回的登录状态结构无法识别，按「未识别」处理，不据此判断是否已登录。',
      expired: false
    }
  }

  const message = signal.safeMessage || FALLBACK_MESSAGE[signal.status]
  const detail = withCode(message, signal.reasonCode)

  if (signal.status === 'LOGGED_IN') {
    return { tone: 'success', label: '已登录', detail, expired: false }
  }
  if (signal.status === 'LOGIN_REQUIRED') {
    const hadSession = signal.sessionPresent === true
    return {
      tone: 'warning',
      label: hadSession ? '登录态已过期' : '未登录',
      detail: hadSession
        ? `该店铺原有会话已被平台判为失效，请重新登录：${detail}`
        : `该店铺还没有可用登录态，请登录后再操作：${detail}`,
      expired: true
    }
  }
  if (signal.status === 'VERIFY_REQUIRED') {
    return { tone: 'warning', label: '需要安全验证', detail, expired: false }
  }
  if (signal.status === 'ERROR') {
    return { tone: 'error', label: '检测失败', detail, expired: false }
  }
  // UNKNOWN：主进程明确表示"这次没拿到证据"，不是未登录
  return { tone: 'info', label: '未识别', detail: `主进程未能确认平台登录状态：${detail}`, expired: false }
}

/** 按钮文案：检测中显示"检测中…"，其余显示动作名。 */
export function loginCheckButtonText(busy: boolean): string {
  return busy ? '检测中…' : '检测登录状态'
}

/**
 * 检测被挡住的第一个原因（空字符串 = 可以检测）。
 *
 * 顺序：没选店 → 应用锁定 → 页面未挂载。前两项连主进程都进不去，
 * 第三项即使调了也只会拿到 UNKNOWN/PAGE_NOT_READY，不如先把原因说清楚。
 */
export function loginCheckBlockedReason(input: LoginCheckGateInput): string {
  if (!input?.storeId) return '先在左栏选择一个店铺，再检测登录状态'
  if (input.appLocked) return '应用已锁定，解锁后才能检测登录状态'
  if (!input.pageAttached) return '该店铺页面还没打开，先打开店铺浏览器再检测登录状态'
  return ''
}

/** 按钮是否可用（disabled 取反）。 */
export function canCheckLogin(input: LoginCheckGateInput): boolean {
  return loginCheckBlockedReason(input) === ''
}
