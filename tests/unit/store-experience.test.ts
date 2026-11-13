import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { storeLastActiveLabel } from '../../apps/desktop/src/renderer/src/features/workbench/store-activity'

/**
 * 店铺日常使用体验守卫（2026-11-13）：
 * 1) 「最近活动」只读真实 last_active_at，不猜；
 * 2) 打开工作区期间卡片/侧栏有明确进行态；
 * 3) 登录状态徽标可以直接点一次单店检测；
 * 4) 浏览器地址栏始终显示当前店铺身份。
 */
const read = (path: string) => readFileSync(path, 'utf8')
const workspace = read('apps/desktop/src/renderer/src/stores/workspace.ts')
const storePage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedStorePage.vue')
const dashboard = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const surface = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')

describe('店铺最近活动文案', () => {
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime()

  it('按真实时间差输出刚刚 / 分钟 / 小时 / 天', () => {
    expect(storeLastActiveLabel(null, now)).toBe('从未打开')
    expect(storeLastActiveLabel(0, now)).toBe('从未打开')
    expect(storeLastActiveLabel(now - 30_000, now)).toBe('刚刚')
    expect(storeLastActiveLabel(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(storeLastActiveLabel(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(storeLastActiveLabel(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  it('超过一周显示日期，不把旧记录说成「很多天前」', () => {
    expect(storeLastActiveLabel(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('2026-10-01')
  })

  it('未来时间按刚刚处理，不产生负数', () => {
    expect(storeLastActiveLabel(now + 60_000, now)).toBe('刚刚')
  })
})

describe('店铺使用体验接线', () => {
  it('打开店铺有进行态，成功后本地刷新最近使用时间', () => {
    expect(workspace).toContain('openingStoreId: null')
    expect(workspace).toContain('this.openingStoreId = storeId')
    expect(workspace).toContain('store.lastActiveAt = Date.now()')
    expect(storePage).toContain("ws.openingStoreId === store.id ? '正在打开…'")
    expect(dashboard).toContain('sb-store-opening')
  })

  it('卡片显示最近活动，并能单店点击状态徽标检测登录', () => {
    expect(storePage).toContain('storeLastActiveLabel(store.lastActiveAt)')
    expect(storePage).toContain('最近活动：')
    expect(storePage).toContain('data-test="`store-login-check-${store.id}`"')
    expect(storePage).toContain('async function checkStoreLogin(')
    expect(storePage).toContain('batchCheckLogin([store.id])')
  })

  it('已打开的店铺按钮改为「切回工作区」，登录失效显示「去登录」', () => {
    expect(storePage).toContain("ws.openStoreIds.includes(store.id) ? '切回工作区'")
    expect(storePage).toContain("store.status === 'needs_login' ? '去登录'")
  })

  it('浏览器地址栏显示当前店铺身份与状态点', () => {
    expect(surface).toContain('data-test="browser-current-store"')
    expect(surface).toContain('当前店铺：${store.name}')
    expect(surface).toContain('browser-store-dot')
  })
})
