import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CUSTOMER_ALERT_THROTTLE_MS,
  CUSTOMER_CHECK_DELAY_BACKGROUND_MS,
  CUSTOMER_CHECK_DELAY_FOCUSED_MS,
  createCustomerAlertState,
  decideCustomerAlert,
  pickCustomerCheckDelayMs,
  shouldShowUnreadBadge,
  sumUnreadCounts
} from '@shared/customer-message-alert'

/**
 * 「实时检测店铺消息」提醒判据的回归网（2026-10-16 用户要求）。
 *
 * 最容易出的两种错：
 *   ① 刷屏：未读一直 >0，每轮检查都弹通知/响一声 → 用节流窗口 + "比上次提醒时更多"才升级；
 *   ② 漏报：用户读掉后又来新消息，却被旧状态压着不再提醒 → 未读回落即解禁。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const MONITOR = read('apps/desktop/src/main/services/customer-message-monitor.ts')

describe('decideCustomerAlert：什么时候提醒、提醒几次', () => {
  const now = 1_000_000

  it('首次出现未读 → 提醒一次（声音必定响；窗口在前台时不弹系统通知）', () => {
    const state = createCustomerAlertState()
    const front = decideCustomerAlert({ unread: 3, now, state, windowFocused: true })
    expect(front.reason).toBe('first-increase')
    expect(front.sound).toBe(true)
    expect(front.notify).toBe(false) // 用户就在看着，不打扰
    const back = decideCustomerAlert({ unread: 3, now, state, windowFocused: false })
    expect(back.notify).toBe(true) // 窗口在后台 → 桌面通知
    expect(back.nextState.lastAlertedUnread).toBe(3)
  })

  it('没变化 / 变少 → 不提醒（变少＝用户读掉了，基线跟着降）', () => {
    const state = { lastUnread: 3, lastAlertedAt: now, lastAlertedUnread: 3 }
    expect(decideCustomerAlert({ unread: 3, now: now + 1000, state, windowFocused: false }).reason).toBe('no-increase')
    const read1 = decideCustomerAlert({ unread: 1, now: now + 1000, state, windowFocused: false })
    expect(read1.reason).toBe('read-reset')
    expect(read1.sound).toBe(false)
    expect(read1.nextState.lastUnread).toBe(1)
  })

  it('读掉后再来新消息 → 立刻再提醒（不许被旧状态压住）', () => {
    // 走真实链路：先提醒 → 用户读掉（未读回落）→ 又来新消息
    const first = decideCustomerAlert({ unread: 3, now, state: createCustomerAlertState(), windowFocused: true })
    expect(first.reason).toBe('first-increase')
    const read = decideCustomerAlert({ unread: 0, now: now + 2_000, state: first.nextState, windowFocused: true })
    expect(read.reason).toBe('read-reset')
    // 解禁必须把 lastAlertedAt 一起归零，否则这里会被上一条的 60s 节流压住
    expect(read.nextState.lastAlertedAt).toBe(0)
    const again = decideCustomerAlert({ unread: 2, now: now + 4_000, state: read.nextState, windowFocused: true })
    expect(again.reason).toBe('first-increase')
    expect(again.sound).toBe(true)
  })

  it('节流窗口内继续增长 → 只更新红点，不重复响（防刷屏）', () => {
    const state = { lastUnread: 3, lastAlertedAt: now, lastAlertedUnread: 3 }
    const bumped = decideCustomerAlert({ unread: 5, now: now + 10_000, state, windowFocused: false })
    expect(bumped.reason).toBe('throttled')
    expect(bumped.sound).toBe(false)
    expect(bumped.notify).toBe(false)
    expect(bumped.unread).toBe(5) // 红点照样更新
    expect(bumped.nextState.lastUnread).toBe(5)
  })

  it('过了节流窗口又多了 → 升级提醒一次', () => {
    const state = { lastUnread: 3, lastAlertedAt: now, lastAlertedUnread: 3 }
    const later = decideCustomerAlert({ unread: 6, now: now + CUSTOMER_ALERT_THROTTLE_MS + 1, state, windowFocused: false })
    expect(later.reason).toBe('escalated')
    expect(later.sound).toBe(true)
    expect(later.notify).toBe(true)
    expect(later.nextState.lastAlertedUnread).toBe(6)
  })

  it('读不到未读（页面未就绪）→ 不提醒也不解禁，保留旧状态', () => {
    const state = { lastUnread: 4, lastAlertedAt: now, lastAlertedUnread: 4 }
    const none = decideCustomerAlert({ unread: null, now: now + 999_999, state, windowFocused: false })
    expect(none.reason).toBe('no-data')
    expect(none.notify).toBe(false)
    expect(none.sound).toBe(false)
    expect(none.nextState).toEqual(state)
  })
})

describe('检测节奏与红点口径', () => {
  it('窗口前台快、后台慢，但都继续（用户要求常驻含后台）', () => {
    expect(pickCustomerCheckDelayMs(true)).toBe(CUSTOMER_CHECK_DELAY_FOCUSED_MS)
    expect(pickCustomerCheckDelayMs(false)).toBe(CUSTOMER_CHECK_DELAY_BACKGROUND_MS)
    expect(CUSTOMER_CHECK_DELAY_FOCUSED_MS).toBeLessThan(CUSTOMER_CHECK_DELAY_BACKGROUND_MS)
    // 后台也不能停：有一档确定的节奏（不是 0/无限）
    expect(CUSTOMER_CHECK_DELAY_BACKGROUND_MS).toBeGreaterThan(0)
    expect(CUSTOMER_CHECK_DELAY_BACKGROUND_MS).toBeLessThanOrEqual(120_000)
  })

  it('总未读只累加真的读到的正数（读不到不虚报）', () => {
    expect(sumUnreadCounts([{ unreadCount: 2 }, { unreadCount: null }, { unreadCount: 0 }, { unreadCount: 3 }])).toBe(5)
    expect(sumUnreadCounts([])).toBe(0)
    expect(sumUnreadCounts([{ unreadCount: Number.NaN }, { unreadCount: -5 }])).toBe(0)
  })

  it('红点只在读到了未读且 >0 时出现（读不到不挂假红点）', () => {
    expect(shouldShowUnreadBadge(1)).toBe(true)
    expect(shouldShowUnreadBadge(0)).toBe(false)
    expect(shouldShowUnreadBadge(null)).toBe(false)
  })
})

describe('接线：主进程按前台/后台选节奏', () => {
  it('调度延迟来自共享判据（不再写死 45_000）', () => {
    expect(MONITOR).toContain('pickCustomerCheckDelayMs')
    expect(MONITOR).toContain('isWindowFocused')
    expect(MONITOR).not.toContain('scheduleNextCheck(45_000)')
  })
})
