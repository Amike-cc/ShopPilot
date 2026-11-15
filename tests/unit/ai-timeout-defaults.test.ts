/**
 * 超时默认值的回归测试。
 *
 * 背景（2026-10-03 实测）：生图链路原先共用文本链路的 30000ms 默认值，
 * 而一次生图实测 25~40 秒——正好卡在边界上，配置正确也会被判超时。
 * 这个测试钉住"生图链路不能再用 30 秒默认值"，避免以后又被合并回去。
 */
import { describe, expect, it } from 'vitest'
import {
  AI_TIMEOUT_MAX_MS,
  AI_IMAGE_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
  DEFAULT_AI_IMAGE_TIMEOUT_MS,
  DEFAULT_AI_TIMEOUT_MS
} from '@shared/constants/ai'

describe('AI 超时默认值', () => {
  it('生图链路默认超时明显大于文本链路的 30 秒（实测一次生图 25~40 秒）', () => {
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(30000)
    expect(DEFAULT_AI_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(90000)
  })

  it('默认值在允许区间内，不会被 clamp 悄悄改小', () => {
    expect(DEFAULT_AI_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(AI_TIMEOUT_MIN_MS)
    expect(DEFAULT_AI_IMAGE_TIMEOUT_MS).toBeLessThanOrEqual(AI_IMAGE_TIMEOUT_MAX_MS)
    expect(AI_TIMEOUT_MAX_MS).toBeLessThanOrEqual(AI_IMAGE_TIMEOUT_MAX_MS)
  })
})
