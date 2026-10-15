import { describe, it, expect } from 'vitest'
import { shouldUseInternalRunTab, USER_FACING_STEP_TYPES } from '../../packages/shared/src/agent-step-effects'

/**
 * 「采集数据时不影响浏览器使用」的规则边界（2026-10-15）。
 *
 * 背景：任务式采集（发票/涉税/主体）以前建**普通标签页**并在每步 `activateTab`，
 * 采集一开始就把用户正在看的页面切走。修法是改用**采集专用页**
 * （`createTab(..., { activate:false, internal:true })`，渲染层隐藏挂载）。
 *
 * 但隐藏页有前提：**用户全程不需要看那一页**。含确认/镜像核对的任务必须可见，
 * 否则用户要对着一个看不见的页面点确认。这条边界就是本文件锁的东西。
 */
describe('任务运行标签页形态：什么时候允许隐藏跑', () => {
  it('纯采集任务 → 允许采集专用页（用户无感）', () => {
    // 发票采集的真实步骤序列（抖店）
    expect(shouldUseInternalRunTab([
      { type: 'navigate' }, { type: 'waitForPage' }, { type: 'waitMs' },
      { type: 'readTable' }, { type: 'clickByText' }, { type: 'waitMs' }, { type: 'readTable' }
    ])).toBe(true)
    // 涉税报送（readApi）
    expect(shouldUseInternalRunTab([{ type: 'navigate' }, { type: 'readApi' }])).toBe(true)
    // 拼多多待开票卡片（readCards）
    expect(shouldUseInternalRunTab([{ type: 'navigate' }, { type: 'readCards' }])).toBe(true)
  })

  it('含「用户要看着页面」的步骤 → **必须**用可见标签页', () => {
    expect(shouldUseInternalRunTab([{ type: 'navigate' }, { type: 'waitForUserConfirmation' }])).toBe(false)
    expect(shouldUseInternalRunTab([{ type: 'mirrorTabUrl' }, { type: 'clickByText' }])).toBe(false)
  })

  it('两种"用户要看"的步骤都在白名单里（改这里必须同时改规则，不许只改一边）', () => {
    expect([...USER_FACING_STEP_TYPES].sort()).toEqual(['mirrorTabUrl', 'waitForUserConfirmation'])
  })

  it('脏数据不炸：缺 type / type 非字符串 / 空数组', () => {
    expect(shouldUseInternalRunTab([])).toBe(true)
    expect(shouldUseInternalRunTab([{}, { type: 123 as unknown as string }])).toBe(true)
    expect(shouldUseInternalRunTab([{ type: null as unknown as string }])).toBe(true)
  })
})
