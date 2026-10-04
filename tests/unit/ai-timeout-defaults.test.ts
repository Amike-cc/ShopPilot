/**
 * 超时默认值的回归测试。
 *
 * 背景（2026-10-03 实测）：生图与"生图文本"两条链路原先共用文本链路的 30000ms 默认值，
 * 而一次卖点分析实测约 21~25 秒、一次生图 25~40 秒——正好卡在边界上，
 * 用户看到的是"AI 分析卖点 不能用"，但配置完全正确。
 * 这个测试钉住"这两条链路不能再用 30 秒默认值"，避免以后又被合并回去。
 */
import { describe, expect, it } from 'vitest'
import {
  AI_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
  DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS,
  DEFAULT_AI_IMAGE_TIMEOUT_MS,
  DEFAULT_AI_TIMEOUT_MS
} from '@shared/constants/ai'

describe('AI 超时默认值', () => {
  it('生图链路默认超时明显大于文本链路的 30 秒（实测一次生图 25~40 秒）', () => {
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(30000)
    expect(DEFAULT_AI_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(90000)
  })

  it('生图文本链路同样不能用 30 秒默认值（实测一次分析 21~25 秒，边界会超时）', () => {
    expect(DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS).toBeGreaterThanOrEqual(90000)
  })

  it('两个默认值都在允许区间内，不会被 clamp 悄悄改小', () => {
    for (const value of [DEFAULT_AI_IMAGE_TIMEOUT_MS, DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS]) {
      expect(value).toBeGreaterThanOrEqual(AI_TIMEOUT_MIN_MS)
      expect(value).toBeLessThanOrEqual(AI_TIMEOUT_MAX_MS)
    }
  })
})
