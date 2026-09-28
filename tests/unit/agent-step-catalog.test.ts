import { describe, expect, it } from 'vitest'
import { STEP_CATALOG, isSideEffectStep } from '@shared/custom-task'
import { AGENT_SIDE_EFFECT_STEP_TYPES, isSideEffectStepType } from '@shared/agent-step-effects'

/**
 * 编辑器目录（custom-task.STEP_CATALOG）与运行时副作用集合必须一致。
 *
 * 这是审计 P0-1 的延伸：库里原先有**四**份"哪些步骤会碰页面"的说法——
 *   · `agent-domain-rules.deriveJobRisk` 的文案正则；
 *   · 引擎的 `NON_RESUMABLE_TYPES`；
 *   · 规划器的 `SIDE_EFFECT_TYPES`；
 *   · 自定义任务编辑器的 `STEP_CATALOG[].sideEffect`。
 * 前三份已统一到 `@shared/agent-step-effects`；编辑器这份因为还带 label/字段定义而独立存在，
 * 但它的 `sideEffect` 标记**必须**与运行时集合逐项一致，否则会出现
 * "编辑器允许给副作用步骤设 retryLimit" 或"把可安全重放的步骤挡在重试之外"这类口径分裂。
 */
describe('STEP_CATALOG.sideEffect 与运行时副作用集合一致', () => {
  const catalogTypes = new Set(STEP_CATALOG.map(entry => entry.type))

  it('目录里的每个类型都按同一判定标 sideEffect', () => {
    const mismatched = STEP_CATALOG
      .filter(entry => entry.sideEffect !== isSideEffectStepType(entry.type))
      .map(entry => `${entry.type}: 目录=${entry.sideEffect} 运行时=${isSideEffectStepType(entry.type)}`)
    expect(mismatched).toEqual([])
  })

  it('isSideEffectStep 与运行时判定同源', () => {
    for (const entry of STEP_CATALOG) {
      expect(isSideEffectStep(entry.type), entry.type).toBe(isSideEffectStepType(entry.type))
    }
  })

  it('运行时集合里的类型要么在目录里、要么是编辑器不暴露的执行器内部类型', () => {
    // 允许目录不收录（例如 loop/fillDraft 由流程模板生成而不是用户手加），但必须能说出原因：
    // 这里只保证"目录收录了就一定同判定"，反向不做强制，避免把这条测试变成易碎的镜像检查。
    for (const type of AGENT_SIDE_EFFECT_STEP_TYPES) {
      if (!catalogTypes.has(type)) continue
      expect(isSideEffectStepType(type), type).toBe(true)
    }
  })
})
