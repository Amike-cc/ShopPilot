import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '../..')
const HANDLERS_SRC = fs.readFileSync(
  path.join(ROOT, 'apps/desktop/src/main/ipc/task-handlers.ts'), 'utf8')

/**
 * TASK_BAD_STATE 友好化的单测。
 *
 * task-handlers.ts 依赖 electron，主进程进不了 vitest，所以这里锁两层：
 * ① 源码里必须保留"from/to 上下文"的友好化逻辑（防有人改回剥离版）；
 * ② 把正则行为复刻出来逐个断言（消息形态变化会静默回退，这里当场失败）。
 *
 * 背景：transition 抛的是 "TASK_BAD_STATE: from -> to (reason)"，
 * from/to 是定位"为什么不让做"的关键上下文（例如 paused 的 run 点"暂停"）。
 * 旧正则把它们剥掉了，只剩 reason，用户看到原因却不知道自己在哪一步。
 */
function friendlyBadState(msg: string): string {
  // 与 task-handlers.ts 的 taskError 里 TASK_BAD_STATE 分支逐行对齐，改那边必须改这里
  const m = msg.replace('TASK_BAD_STATE:', '').trim().slice(0, 300)
  const st = m.match(/^(\S+)\s*->\s*(\S+)\s*\((.*)\)\s*$/)
  return st
    ? `当前状态为「${st[1]}」，不允许该操作（${st[3]}）`
    : (m || '当前任务状态不允许该操作')
}

describe('TASK_BAD_STATE · 友好化', () => {
  it('源码保留状态上下文（from/to 不许再被剥掉）', () => {
    expect(HANDLERS_SRC).toContain('TASK_BAD_STATE')
    expect(HANDLERS_SRC, '必须保留 from/to 上下文的友好化').toMatch(/当前状态为/)
  })

  it('标准形态保留 from 并带出 reason', () => {
    expect(friendlyBadState('TASK_BAD_STATE: paused -> paused (仅运行中可暂停)'))
      .toBe('当前状态为「paused」，不允许该操作（仅运行中可暂停）')
    expect(friendlyBadState('TASK_BAD_STATE: running -> paused (用户暂停)'))
      .toBe('当前状态为「running」，不允许该操作（用户暂停）')
  })

  it('非标准形态原样透出（不伪造状态）', () => {
    expect(friendlyBadState('TASK_BAD_STATE: 该任务已有未结束的运行，请先等待'))
      .toBe('该任务已有未结束的运行，请先等待')
    expect(friendlyBadState('TASK_BAD_STATE:'))
      .toBe('当前任务状态不允许该操作')
  })

  it('超长截断（防超长 reason 撑爆界面）', () => {
    const long = 'TASK_BAD_STATE: ' + 'x'.repeat(500)
    expect(friendlyBadState(long).length).toBeLessThanOrEqual(300)
  })
})
