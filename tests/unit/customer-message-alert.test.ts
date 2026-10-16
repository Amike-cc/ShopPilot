import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
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
import {
  __setAudioContextForTest,
  playCustomerMessageBeep,
  setCustomerMessageSoundEnabled
} from '../../apps/desktop/src/renderer/src/features/customer-service/customer-message-sound'

/**
 * 「实时检测店铺消息」提醒判据的回归网（2026-10-16 用户要求）。
 *
 * 最容易出的两种错：
 *   ① 刷屏：未读一直 >0，每轮检查都弹通知/响一声 → 用节流窗口 + "比上次提醒时更多"才升级；
 *   ② 漏报：用户读掉后又来新消息，却被旧状态压着不再提醒 → 未读回落即解禁。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const MONITOR = read('apps/desktop/src/main/services/customer-message-monitor.ts')
const WORKSPACE = read('apps/desktop/src/renderer/src/stores/workspace.ts')
const SOUND = read('apps/desktop/src/renderer/src/features/customer-service/customer-message-sound.ts')

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

  it('只有真读到未读数才谈提醒（CHECKING/错误不提醒）', () => {
    const fn = MONITOR.match(/private emit\(item: CustomerMessageCheck\)[\s\S]*?\n {2}\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain("if (typeof item.unreadCount === 'number') this.applyUnreadAlert(item)")
  })

  it('提醒走共享判据；桌面通知只在窗口不在前台时弹，点击才切店', () => {
    const fn = MONITOR.match(/private applyUnreadAlert[\s\S]*?\n {2}\}/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain('decideCustomerAlert({')
    expect(fn![0]).toContain('windowFocused: this.runtime.isWindowFocused?.() === true')
    expect(fn![0]).toContain('if (decision.notify)')
    expect(fn![0]).toContain('new Notification({')
    expect(fn![0]).toContain("notification.on('click'")
    expect(fn![0]).toContain('this.runtime.displayStore?.(item.storeId)')
    // 未读状态按店铺各存一份
    expect(MONITOR).toContain('private readonly alertStates = new Map<string, CustomerAlertState>()')
  })

  it('提醒事件走新通道，且带上"是否已弹桌面通知"供界面决定声音', () => {
    expect(EVENT_CHANNELS.CUSTOMER_SERVICE_NEW_MESSAGE).toBe('customerService:newMessage')
    expect(MONITOR).toContain('EVENT_CHANNELS.CUSTOMER_SERVICE_NEW_MESSAGE')
    expect(MONITOR).toMatch(/desktopNotified: decision\.notify/)
    expect(MONITOR).toMatch(/sound: decision\.sound/)
  })
})

describe('界面侧：红点数据 + 提示音', () => {
  it('订阅新消息事件 → 更新未读红点，且只在 sound=true 时响', () => {
    const fn = WORKSPACE.match(/on\(EVENT_CHANNELS\.CUSTOMER_SERVICE_NEW_MESSAGE[\s\S]*?\n {6}\}\)/)
    expect(fn).toBeTruthy()
    expect(fn![0]).toContain("if (payload.sound === true) playCustomerMessageBeep()")
    expect(WORKSPACE).toContain('customerUnread: {} as Record<string, number>')
    expect(WORKSPACE).toMatch(/this\.customerUnread = \{ \.\.\.this\.customerUnread, \[payload\.storeId\]: unread \}/)
  })

  it('提示音可关：关掉后一次都不发声', () => {
    const started: number[] = []
    const fakeAudioContext = function (this: unknown) {
      return {
        currentTime: 0,
        destination: {},
        createOscillator: () => ({ type: '', frequency: { value: 0 }, connect() {}, start(at: number) { started.push(at) }, stop() {} }),
        createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} })
      }
    }
    __setAudioContextForTest(fakeAudioContext)
    setCustomerMessageSoundEnabled(false)
    playCustomerMessageBeep()
    expect(started).toHaveLength(0)
    setCustomerMessageSoundEnabled(true)
    playCustomerMessageBeep()
    expect(started).toHaveLength(2) // 两声短提示
    __setAudioContextForTest(undefined)
    setCustomerMessageSoundEnabled(true)
  })

  it('没有音频能力时静默不抛（提醒主体是红点与通知）', () => {
    __setAudioContextForTest(undefined)
    expect(() => playCustomerMessageBeep()).not.toThrow()
    // 声音模块自身也要可关 + 失败静默（源码级：默认开、开关函数、catch 兜底）
    expect(SOUND).toContain('let soundEnabled = true')
    expect(SOUND).toContain('export function setCustomerMessageSoundEnabled')
    expect(SOUND).toContain('} catch {')
  })
})
