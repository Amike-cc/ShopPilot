import { describe, it, expect } from 'vitest'
import { anchorNextFire } from '../../apps/desktop/src/main/tasks/scheduler'

/**
 * 调度器重启节拍锚定的单测。
 *
 * 防的是"每次重启触发时刻越漂越远"：首次节拍必须锚到上次真实触发
 * （tasks.last_fired_at + 周期），而不是"重启时刻 + 周期"。
 * 停机期间错过的周期不补偿——立即连发积压 run 比晚一次危险得多。
 */
describe('调度器 · 重启节拍锚定', () => {
  const EVERY = 3600_000
  const NOW = 1_700_000_000_000

  it('有上次触发且锚定点在未来 → 锚到 lastFiredAt + 周期', () => {
    expect(anchorNextFire(NOW - 1000, EVERY, NOW)).toBe(NOW - 1000 + EVERY)
  })

  it('锚定点已过去（停机错过周期）→ 不补偿，直接开新周期', () => {
    expect(anchorNextFire(NOW - EVERY * 3, EVERY, NOW)).toBe(NOW + EVERY)
  })

  it('没有上次触发（0/负数/非数字）→ 按重启时刻开新周期', () => {
    expect(anchorNextFire(0, EVERY, NOW)).toBe(NOW + EVERY)
    expect(anchorNextFire(-5, EVERY, NOW)).toBe(NOW + EVERY)
    expect(anchorNextFire(undefined, EVERY, NOW)).toBe(NOW + EVERY)
    expect(anchorNextFire(null, EVERY, NOW)).toBe(NOW + EVERY)
  })

  it('锚定点恰好等于现在 → 视为过期，开新周期（避免立即连发）', () => {
    expect(anchorNextFire(NOW - EVERY, EVERY, NOW)).toBe(NOW + EVERY)
  })
})
