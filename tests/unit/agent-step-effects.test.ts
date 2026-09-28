import { describe, expect, it } from 'vitest'
import {
  AGENT_NON_RESUMABLE_STEP_TYPES,
  AGENT_SIDE_EFFECT_STEP_TYPES,
  collectStepTypes,
  hasNonResumableSteps,
  hasSideEffectSteps,
  isNonResumableStepType,
  isSideEffectStepType
} from '@shared/agent-step-effects'
import { deriveJobRisk } from '@shared/agent-domain-rules'
import { NON_RESUMABLE_TYPES } from '../../apps/desktop/src/main/tasks/task-step-schemas'

/**
 * 副作用边界单一事实来源（审计 P0-1 的回归测试）。
 *
 * 背景：这条边界原先有三份不一致的实现——`deriveJobRisk` 只按文案正则、
 * 引擎的 `NON_RESUMABLE_TYPES` 有 13 项、规划器只有 click/clickByText 两项。
 * 结果是 `"type":"clickByText"` / `setInput` / `typeText` / `aiGenerate` 等步骤
 * 被判成 `read`：可派给只读执行者，且不置 `side_effect_started` → 允许"安全恢复"
 * 从第 0 步重放 → 重复点击/重复写入。
 */

const CLICK_LIKE = ['click', 'clickByText', 'clickAll', 'clickIfPresent']
const WRITE_LIKE = ['setInput', 'typeText', 'ensureRows', 'ensureRowsById', 'fillDraft', 'aiGenerate']

describe('agent-step-effects：单一事实来源', () => {
  it('引擎的 NON_RESUMABLE_TYPES 就是 shared 的这个集合（集合同一性，不是"内容恰好一样"）', () => {
    expect(NON_RESUMABLE_TYPES).toBe(AGENT_NON_RESUMABLE_STEP_TYPES)
  })

  it('所有会碰页面的步骤类型都在副作用集合里', () => {
    for (const type of [...CLICK_LIKE, ...WRITE_LIKE, 'loop']) {
      expect(isSideEffectStepType(type), `${type} 应算副作用`).toBe(true)
    }
  })

  it('纯运行态/等待类不可重放，但不算副作用（重放安全性的两种原因要分清）', () => {
    expect(isNonResumableStepType('waitForUserConfirmation')).toBe(true)
    expect(isNonResumableStepType('useTab')).toBe(true)
    expect(isSideEffectStepType('waitForUserConfirmation')).toBe(false)
    expect(isSideEffectStepType('useTab')).toBe(false)
    // hover / pressKey(Escape) / 读取类故意不在名单里：不改页面状态，可安全重放
    for (const type of ['hover', 'pressKey', 'navigate', 'readText', 'readTable', 'waitForPage', 'screenshot']) {
      expect(isNonResumableStepType(type), `${type} 不该被判不可重放`).toBe(false)
    }
  })

  it('副作用集合是"不可重放集合"的子集', () => {
    for (const type of AGENT_SIDE_EFFECT_STEP_TYPES) {
      expect(AGENT_NON_RESUMABLE_STEP_TYPES.has(type), `${type} 应同时不可重放`).toBe(true)
    }
  })

  it('能递归进 loop 的 body/steps 找到副作用步骤', () => {
    const loopTask = { name: '循环发送', steps: [{ type: 'loop', input: { body: [{ type: 'clickByText' }, { type: 'readText' }] } }] }
    expect(hasSideEffectSteps(loopTask)).toBe(true)
    expect(collectStepTypes(loopTask)).toEqual(['loop', 'clickByText', 'readText'])
    const readOnly = { name: '只读', steps: [{ type: 'navigate' }, { type: 'readText' }] }
    expect(hasSideEffectSteps(readOnly)).toBe(false)
    expect(hasNonResumableSteps(readOnly)).toBe(false)
  })
})

describe('deriveJobRisk：步骤类型是权威信号', () => {
  const browserTask = (steps: Array<Record<string, unknown>>) => ({ name: '任务', storeScope: null, steps })

  it('纯文案匹配不到的副作用步骤不再被判成 read（回归）', () => {
    for (const type of [...CLICK_LIKE, ...WRITE_LIKE]) {
      const risk = deriveJobRisk({ goal: '目标A', inputSummary: {}, browserTask: browserTask([{ type }]) })
      expect(risk, `${type} 的风险等级`).toBe('write')
    }
  })

  it('loop 里含副作用步骤同样按 write 处理', () => {
    const risk = deriveJobRisk({ goal: '目标B', inputSummary: {}, browserTask: browserTask([{ type: 'loop', input: { body: [{ type: 'setInput' }] } }]) })
    expect(risk).toBe('write')
  })

  it('只读步骤仍判 read（不误伤）', () => {
    const risk = deriveJobRisk({ goal: '读取库存', inputSummary: {}, browserTask: browserTask([{ type: 'navigate' }, { type: 'readText' }]) })
    expect(risk).toBe('read')
    expect(deriveJobRisk({ goal: '读取库存', inputSummary: {}, browserTask: null })).toBe('read')
  })

  it('提交/资金类文案继续判 submit（优先级最高）', () => {
    expect(deriveJobRisk({ goal: '发布商品', inputSummary: {}, browserTask: null })).toBe('submit')
    expect(deriveJobRisk({ goal: '目标C', inputSummary: {}, browserTask: browserTask([{ type: 'clickByText' }]), idempotencyKey: '提交订单' } as any)).toBe('write')
    expect(deriveJobRisk({ goal: '发送邀约私信', inputSummary: {}, browserTask: browserTask([{ type: 'readText' }]) })).toBe('submit')
  })
})
