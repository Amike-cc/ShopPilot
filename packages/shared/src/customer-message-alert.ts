/**
 * 客服消息提醒的判据（2026-10-16 用户要求「电商客服：实时检测店铺消息」）。
 *
 * 已确认口径：所有已登录店铺常驻监测（含窗口在后台）；提醒＝侧栏红点+未读数、
 * Windows 桌面通知、提示音；**不做**自动切店。
 *
 * 为什么判据要单独放一处：提醒最容易出的两种错——
 *   ① **刷屏**：每轮检查都比上一轮"未读>0"，于是每轮都弹一次通知/响一声；
 *   ② **漏报后的补刀**：用户已经看过（未读回落到 0）又被旧状态压着不再提醒。
 * 这两件事只能靠"未读从少变多 + 节流窗口 + 归零解禁"的状态机说清楚，所以用真值表钉死，
 * 主进程只负责把状态存下来、把决定变成通知与声音。
 */

/** 两次提醒之间的最短间隔：未读持续增长时也最多这么久提醒一次，避免刷屏 */
export const CUSTOMER_ALERT_THROTTLE_MS = 60_000

/** 检测节奏：窗口在前台（用户正看着）时快，切到后台时慢——但**不中断**（用户口径） */
export const CUSTOMER_CHECK_DELAY_FOCUSED_MS = 12_000
export const CUSTOMER_CHECK_DELAY_BACKGROUND_MS = 45_000

/** 每家店的提醒状态（由调用方持久保存，纯函数不持有状态） */
export interface CustomerAlertState {
  /** 上一次看到的未读数（null = 还没读到） */
  lastUnread: number | null
  /** 上一次真的提醒的时刻（0 = 还没提醒过） */
  lastAlertedAt: number
  /** 上一次提醒时的未读数（用于"又多了"的升级判断） */
  lastAlertedUnread: number
}

export function createCustomerAlertState(): CustomerAlertState {
  return { lastUnread: null, lastAlertedAt: 0, lastAlertedUnread: 0 }
}

export interface CustomerAlertInput {
  /** 这次读到的未读数（null = 这次没读到，例如页面未就绪——不该据此提醒或解禁） */
  unread: number | null
  now: number
  state: CustomerAlertState
  /** 窗口是否在前台：前台不弹系统通知（用户就在看），但仍更新红点与计数 */
  windowFocused: boolean
}

export interface CustomerAlertDecision {
  /** 侧栏红点/未读数是每次读数都要更新的，与是否提醒无关 */
  unread: number | null
  /** 是否弹桌面通知 */
  notify: boolean
  /** 是否响提示音 */
  sound: boolean
  /** 下一次的提醒状态 */
  nextState: CustomerAlertState
  /** 为什么（写日志与单测断言用） */
  reason: 'no-data' | 'no-increase' | 'read-reset' | 'first-increase' | 'escalated' | 'throttled'
}

/**
 * 决定"这次读数要不要提醒"。
 *
 * 规则（按顺序）：
 *   1. 没读到（unread === null）→ 只保留旧状态，不提醒、不解禁；
 *   2. 未读变少（说明用户已读了一部分）→ 记为新的基线，并把节流解禁（lastAlertedUnread 归 0），
 *      这样"读掉后又来新消息"能立刻再提醒一次；
 *   3. 未读没变或变多但没超过上次提醒过的量 → 不提醒；
 *   4. 首次增长，或比"上次提醒时"又多出消息且已过节流窗口 → 提醒（通知 + 声音）；
 *   5. 增长但还在节流窗口内 → 只更新红点，不提醒（throttled）。
 */
export function decideCustomerAlert(input: CustomerAlertInput): CustomerAlertDecision {
  const { unread, now, state, windowFocused } = input
  if (unread === null || !Number.isFinite(unread) || unread < 0) {
    return { unread: null, notify: false, sound: false, nextState: state, reason: 'no-data' }
  }

  const previous = state.lastUnread
  // 未读回落（用户读掉了一部分或全部）＝基线更新 + 解禁：之后再来新消息要能立刻提醒
  // （解禁要把 lastAlertedAt 一起归零，否则"读掉→马上来新消息"会被上一条的节流窗口压住）
  if (previous !== null && unread < previous) {
    return {
      unread,
      notify: false,
      sound: false,
      nextState: { lastUnread: unread, lastAlertedAt: 0, lastAlertedUnread: 0 },
      reason: 'read-reset'
    }
  }

  const increased = previous === null ? unread > 0 : unread > previous
  if (!increased) {
    return { unread, notify: false, sound: false, nextState: { ...state, lastUnread: unread }, reason: 'no-increase' }
  }

  const firstTime = state.lastAlertedAt === 0
  const elapsed = now - state.lastAlertedAt
  const throttled = !firstTime && elapsed < CUSTOMER_ALERT_THROTTLE_MS
  if (throttled) {
    return { unread, notify: false, sound: false, nextState: { ...state, lastUnread: unread }, reason: 'throttled' }
  }

  const escalated = state.lastAlertedUnread > 0 && unread > state.lastAlertedUnread
  return {
    unread,
    notify: !windowFocused, // 用户就在看着这个软件时不必再弹系统通知，红点与声音足够
    sound: true,
    nextState: { lastUnread: unread, lastAlertedAt: now, lastAlertedUnread: unread },
    reason: firstTime ? 'first-increase' : (escalated ? 'escalated' : 'first-increase')
  }
}

/** 检测节奏：窗口前台快、后台慢，但都继续（用户要求常驻，含后台） */
export function pickCustomerCheckDelayMs(windowFocused: boolean): number {
  return windowFocused ? CUSTOMER_CHECK_DELAY_FOCUSED_MS : CUSTOMER_CHECK_DELAY_BACKGROUND_MS
}

/** 侧栏总未读：只统计读到了的店（没读到的店按 0 算，不虚报） */
export function sumUnreadCounts(rows: ReadonlyArray<{ unreadCount: number | null }>): number {
  let total = 0
  for (const row of rows) {
    const value = row?.unreadCount
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value
  }
  return total
}

/** 是否值得给这家店挂红点：读到了未读且 > 0（读不到时不给红点，避免假警报） */
export function shouldShowUnreadBadge(unreadCount: number | null): boolean {
  return typeof unreadCount === 'number' && Number.isFinite(unreadCount) && unreadCount > 0
}
