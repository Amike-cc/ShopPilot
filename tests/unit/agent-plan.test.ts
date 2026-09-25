import { describe, expect, it } from 'vitest'
import { validateAgentPlan, parseAgentPlanProposal, AgentPlanningError } from '../../apps/desktop/src/main/services/agent-planner'
import type { AgentPageObservation } from '@shared/schemas/agent'

const observation: AgentPageObservation = {
  storeId: 'store_demo', storeName: '演示店铺', storePlatform: '测试平台', tabId: 'tab_current',
  tabTitle: '订单管理', currentUrl: 'https://shop.example/orders?session=secret', pageTitle: '订单管理',
  visibleTextSummary: '今日订单 · 成交金额 · 筛选',
  buttons: [
    { text: '筛选', selector: 'button#filter' },
    { text: '提交订单', selector: 'button#submit' }
  ], inputs: [],
  tables: [{ selector: 'table#orders', headers: ['订单号', '成交金额'], rowCount: 7 }],
  selectorCandidates: ['title', 'h1', 'button#filter', 'button#submit', 'table#orders'],
  interactive: true,
  screenshot: { ref: 'shot_demo', capturedAt: 1, available: false, dataUrl: null, errorCode: null }
}

function proposal(steps: unknown[], schedule: { everyMs: number } | null = null) {
  return JSON.stringify({ name: '读取页面数据', steps, schedule })
}

function expectPlanningError(fn: () => unknown, code?: string) {
  try { fn(); throw new Error('预期计划校验失败') } catch (error) {
    expect(error).toBeInstanceOf(AgentPlanningError)
    if (code) expect((error as AgentPlanningError).code).toBe(code)
  }
}

describe('Agent structured plan', () => {
  it('parses a safe current-page title plan and converts it to task:create input', () => {
    const plan = parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'title' }, description: '读取当前页面标题' }
    ]), '读取当前页面标题', observation)
    const validated = validateAgentPlan(plan, observation)
    expect(validated.changed).toBe(false)
    expect(validated.taskInput.storeScope).toBe('store_demo')
    expect(validated.taskInput.steps[0]).toMatchObject({ type: 'useTab', input: { tabId: 'tab_current', closeCurrent: false } })
    expect(validated.taskInput.steps[1]).toMatchObject({ type: 'readText', input: { selector: 'title', privacyRedact: true } })
  })

  it('rejects JavaScript, shell, file paths, loops, and model-supplied confirmation steps', () => {
    for (const type of ['executeJavaScript', 'shell', 'file', 'loop', 'waitForUserConfirmation']) {
      expectPlanningError(() => parseAgentPlanProposal(proposal([
        { type, input: { script: 'document.cookie', command: 'whoami', path: 'C:\\secret' }, description: '不允许的步骤' }
      ]), '读取页面', observation))
    }
  })

  it('adds a manual confirmation gate only for money actions, ordinary clicks run directly', () => {
    const plain = parseAgentPlanProposal(proposal([
      { type: 'clickByText', input: { text: '筛选' }, description: '展开筛选' }
    ]), '展开筛选', observation)
    expect(plain.requiresConfirmation).toBe(false)
    expect(plain.steps.map(step => step.type)).toEqual(['useTab', 'clickByText'])

    const money = parseAgentPlanProposal(proposal([
      { type: 'clickByText', input: { text: '提交订单' }, description: '提交订单' }
    ]), '提交订单', observation)
    expect(money.requiresConfirmation).toBe(true)
    expect(money.steps.map(step => step.type)).toEqual(['useTab', 'waitForUserConfirmation', 'clickByText'])
    expect(money.steps[1].risk).toBe('submit')
    expect(money.steps[1].input.message).toContain('演示店铺')
    expect(validateAgentPlan(money, observation).taskInput.steps[1].type).toBe('waitForUserConfirmation')
  })

  it('requires readTable to return only observed headers and row count', () => {
    const plan = parseAgentPlanProposal(proposal([
      { type: 'readTable', input: { selector: 'table#orders' }, description: '读取订单列表统计' }
    ]), '读取订单数量', observation)
    expect(plan.steps[1].input).toMatchObject({ selector: 'table#orders', headersOnly: true, keepRows: false })
    expect(validateAgentPlan(plan, observation).taskInput.steps[1].input).toMatchObject({ headersOnly: true, keepRows: false })
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'readTable', input: { selector: 'table#orders', keepRows: true }, description: '读取订单' }
    ]), '读取订单', observation), 'AGENT_SENSITIVE_READ_BLOCKED')
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'readTable', input: { selector: 'table#orders', pickByHeader: '订单号' }, description: '读取订单' }
    ]), '读取订单', observation), 'AGENT_INPUT_NOT_ALLOWED')
  })

  it('rejects unobserved selectors, cross-origin URLs, and sensitive customer labels', () => {
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'body' }, description: '读整页' }
    ]), '读整页', observation), 'AGENT_SELECTOR_NOT_OBSERVED')
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'navigate', input: { url: 'https://outside.example/' }, description: '跳转' }
    ]), '跳转', observation), 'AGENT_URL_NOT_ALLOWED')
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'readLabelValue', input: { label: '收货人' }, description: '读取客户' }
    ]), '读取收货人', observation), 'AGENT_SENSITIVE_READ_BLOCKED')
  })

  it('maps bounded scheduler settings through to the existing task input', () => {
    const plan = parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'title' }, description: '读取标题' }
    ], { everyMs: 3600000 }), '每小时读取标题', observation)
    const validated = validateAgentPlan(plan, observation)
    expect(validated.taskInput.schedule).toEqual({ everyMs: 3600000 })
  })

  it('rejects a plan after the current store or tab context changes', () => {
    const plan = parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'title' }, description: '读取标题' }
    ]), '读取标题', observation)
    expectPlanningError(() => validateAgentPlan(plan, { ...observation, tabId: 'tab_other' }), 'AGENT_CONTEXT_CHANGED')
  })

  it('rejects arbitrary code fields and oversized prompt text after renderer edits', () => {
    const plan = parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'title' }, description: '读取标题' }
    ]), '读取标题', observation)
    const edited = JSON.parse(JSON.stringify(plan))
    edited.steps[1].input.script = 'document.cookie'
    expectPlanningError(() => validateAgentPlan(edited, observation), 'AGENT_INPUT_NOT_ALLOWED')
    expectPlanningError(() => parseAgentPlanProposal(proposal([
      { type: 'readText', input: { selector: 'title' }, description: 'x'.repeat(121) }
    ]), '读取标题', observation))
  })
})
