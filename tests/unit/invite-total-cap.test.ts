import { describe, expect, it } from 'vitest'
import { inviteProfileFor } from '@shared/constants/invite'
import { buildInviteSteps, type StepDraft } from '@shared/invite-steps'

/**
 * 本次总量口径（2026-10-25 重构）。
 *
 * 旧实现：campaign.target_count = 每批人数，loop 最多 20 轮 → 预留 40、实发可达 800。
 * 新口径：totalCap 是整单硬上限；轮数按总量收敛，最后一批由引擎按剩余量少勾。
 *
 * 用快手档案验证：抖店已改逐人沟通（一位一轮，count 即总量），没有"每批/多轮"两层语义。
 */
const profile = inviteProfileFor('快手小店')

function buildBatch(totalCap: number, count: number) {
  return buildInviteSteps(profile!, {
    batch: {
      category: '',
      levels: [],
      count,
      totalCap,
      script: '冒烟话术',
      scriptMode: 'manual',
      benefits: [],
      recentlyInvited: []
    }
  }, 'https://fxg.jinritemai.com/ffa/mshop/daren-square')
}

function loopOf(steps: StepDraft[]): any {
  const loop = steps.find(step => step.type === 'loop')
  expect(loop).toBeTruthy()
  return loop
}

describe('批量邀约的本次总量（totalCap）', () => {
  it('总量 100、每批 40 → 最多 3 轮（第 3 轮只勾剩余 20）', () => {
    const loop = loopOf(buildBatch(100, 40))
    expect(loop.input.totalCap).toBe(100)
    expect(loop.input.maxRounds).toBe(3)
  })

  it('总量小于每批时按每批下限收敛，不会出现"计划 10 实发 40"', () => {
    const loop = loopOf(buildBatch(10, 40))
    // 引擎侧 totalCap 会被抬到 need（否则一轮都凑不满），这里断言两者一致
    expect(loop.input.totalCap).toBe(40)
    expect(loop.input.maxRounds).toBe(1)
  })

  it('缺省总量按每批 × 20 轮封顶 500（旧行为上限）', () => {
    const loop = loopOf(buildBatch(0 as unknown as number, 40))
    expect(loop.input.totalCap).toBe(500)
    expect(loop.input.maxRounds).toBe(13)
  })

  it('发送按钮标记 markSendAttempt：发送后中断才能把名单记为 unknown', () => {
    const loop = loopOf(buildBatch(80, 40))
    const marked = (loop.input.steps as Array<{ type: string; input?: Record<string, unknown> }>)
      .filter(step => step.type === 'clickByText' && step.input?.markSendAttempt === true)
    expect(marked.length).toBe(1)
  })
})
