import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_CATALOG, buildToolWhitelistText, isSkillStepAllowed, listSkillStepTools, skillStepEligible, toolApprovalRequired } from '@shared/agent-tools'
import { AGENT_CONFIRM_REQUIRED_ACTIONS, softwareActionHasSideEffect } from '@shared/agent-domain-rules'
import { AGENT_SOFTWARE_ACTION_TYPES, agentPluginDeleteInputSchema, agentPluginUpdateInputSchema, agentSkillCreateInputSchema, agentSoftwareActionSchema, agentSkillSchema } from '@shared/schemas/agent'
import { AGENT_TOOL_LABELS } from '@shared/agent-tool-labels'

describe('Agent tool catalog', () => {
  it('covers every closed software action exactly once', () => {
    const types = AGENT_TOOL_CATALOG.map(tool => tool.type)
    expect(new Set(types).size).toBe(types.length)
    expect([...types].sort()).toEqual([...AGENT_SOFTWARE_ACTION_TYPES].sort())
  })

  it('every catalog example is a valid action of its declared type', () => {
    for (const tool of AGENT_TOOL_CATALOG) {
      const parsed = agentSoftwareActionSchema.safeParse(JSON.parse(tool.example))
      expect(parsed.success, `${tool.type} example must parse`).toBe(true)
      if (parsed.success) expect(parsed.data.type).toBe(tool.type)
    }
  })

  it('skill steps exclude nested skill/plugin management and stay declarative', () => {
    expect(isSkillStepAllowed('listStores')).toBe(true)
    expect(isSkillStepAllowed('collectBusiness')).toBe(true)
    expect(isSkillStepAllowed('createSkill')).toBe(false)
    expect(isSkillStepAllowed('runSkill')).toBe(false)
    expect(isSkillStepAllowed('deleteSkill')).toBe(false)
    expect(isSkillStepAllowed('createPlugin')).toBe(false)
    expect(isSkillStepAllowed('listTools')).toBe(false)
  })

  it('marks money and irreversible tools as approval required', () => {
    expect(toolApprovalRequired('deleteStorePermanent')).toBe(true)
    expect(toolApprovalRequired('listStores')).toBe(false)
    expect(toolApprovalRequired('collectBusiness')).toBe(false)
  })

  it('renders a whitelist prompt with approval markers and no script surface', () => {
    const text = buildToolWhitelistText()
    expect(text).toContain('需确认')
    expect(text).toContain('"type":"createSkill"')
    expect(text).not.toMatch(/shell|javascript|readfile|executeJavaScript/i)
    expect(text.split('\n').length).toBe(AGENT_TOOL_CATALOG.length)
  })

  it('skill schema defaults step input and rejects oversized skills', () => {
    const skill = agentSkillSchema.parse({ id: 'skill_1', name: '巡检', description: '', intent: '', steps: [{ type: 'listStores' }], status: 'enabled', source: 'ai', pluginId: null, createdAt: 1, updatedAt: 1 })
    expect(skill.steps[0]).toEqual({ type: 'listStores', input: {}, description: '' })
    expect(agentSkillSchema.safeParse({ ...skill, steps: Array.from({ length: 9 }, () => ({ type: 'listStores' })) }).success).toBe(false)
  })

  // 面板「新建技能」表单与 Main 的技能校验共用同一判定：
  // 表单能给出的步骤，校验必须收；校验会拒的步骤，表单不能给。
  it('skill step eligibility keeps read-only tools and drops approval-gated ones', () => {
    expect(skillStepEligible('listStores')).toBe(true)
    expect(skillStepEligible('listJobs')).toBe(true)
    expect(skillStepEligible('collectBusiness')).toBe(true)
    expect(skillStepEligible('getOrderDetails')).toBe(true)
    expect(skillStepEligible('createTask')).toBe(false)
    expect(skillStepEligible('closeTab')).toBe(false)
    expect(skillStepEligible('deleteStorePermanent')).toBe(false)
    expect(skillStepEligible('closeStore')).toBe(false)
    expect(skillStepEligible('runInvite')).toBe(false)
    expect(skillStepEligible('createSkill')).toBe(false)
    expect(skillStepEligible('createPlugin')).toBe(false)
  })

  it('panel tool list is exactly the eligible subset and never offers a rejected step', () => {
    const tools = listSkillStepTools()
    const eligible = AGENT_TOOL_CATALOG.filter(tool => skillStepEligible(tool.type)).map(tool => tool.type)
    expect(tools.map(tool => tool.type)).toEqual(eligible)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThan(AGENT_TOOL_CATALOG.length)
    for (const tool of tools) {
      const params = JSON.parse(tool.params) as Record<string, unknown>
      expect(params && typeof params === 'object' && !Array.isArray(params), `${tool.type} params must be an object`).toBe(true)
      expect(params.type, `${tool.type} params must not repeat the type`).toBeUndefined()
      // 目录示例里的 "..." 是给人看的占位符，不能原样当成参数预填进去
      expect(tool.params.includes('...'), `${tool.type} params must not keep placeholders`).toBe(false)
      expect(tool.example.includes(tool.type)).toBe(true)
      // 模板里没有待填字段（空串）时，它必须能直接被 action schema 接受
      if (!hasEmptyLeaf(params)) {
        expect(agentSoftwareActionSchema.safeParse({ type: tool.type, ...params }).success, `${tool.type} complete template must parse`).toBe(true)
      }
    }
    const types = tools.map(tool => tool.type)
    for (const forbidden of ['createSkill', 'runSkill', 'createPlugin', 'listTools', 'createTask', 'closeTab', 'closeStore', 'runInvite', 'deleteSkill', 'updateSkill']) {
      expect(types).not.toContain(forbidden)
    }
  })

  it('panel create-skill input mirrors the model action shape and rejects script payloads', () => {
    expect(agentSkillCreateInputSchema.parse({ name: ' 巡检 ', steps: [{ type: 'listStores' }] }))
      .toEqual({ name: '巡检', description: '', intent: '', steps: [{ type: 'listStores', input: {} }] })
    expect(agentSkillCreateInputSchema.safeParse({ name: '巡检', steps: [] }).success).toBe(false)
    expect(agentSkillCreateInputSchema.safeParse({ name: '   ', steps: [{ type: 'listStores' }] }).success).toBe(false)
    expect(agentSkillCreateInputSchema.safeParse({ name: '巡检', steps: Array.from({ length: 9 }, () => ({ type: 'listStores' })) }).success).toBe(false)
    expect(agentSkillCreateInputSchema.safeParse({ name: '巡检', steps: [{ type: 'listStores', input: {}, script: 'rm -rf /' }] }).success).toBe(false)
  })

  // 第二批工具的门禁分类必须与「只读自动、变更需确认」这条线一致：
  // 一旦把 approveJob/deletePlugin 这类动作漏出确认门，智能体就能自我批准或直接删插件。
  it('second batch of tools splits auto-run reads from approval-gated changes', () => {
    const autoRun = ['getJobDetail', 'jobFeedback', 'resumeJob', 'qualityMetrics', 'qualityReview', 'overviewStats', 'overviewDatacenter', 'overviewInvoiceCenter', 'memoryRebuild', 'memorySnapshot']
    const gated = ['approveJob', 'reviewJobResult', 'cancelJob', 'updateAgent', 'bindAgentModel', 'updatePlugin', 'deletePlugin', 'updateTask', 'applyEntity']
    for (const type of autoRun) expect(toolApprovalRequired(type), `${type} 不应要求确认`).toBe(false)
    for (const type of gated) expect(toolApprovalRequired(type), `${type} 必须要求确认`).toBe(true)
    // 两个集合互斥且都在目录里（防止名字写错导致断言空转）
    const catalogTypes = AGENT_TOOL_CATALOG.map(tool => tool.type)
    for (const type of [...autoRun, ...gated]) expect(catalogTypes, `${type} 必须在目录里`).toContain(type)
    for (const type of autoRun) expect(gated).not.toContain(type)
  })

  /**
   * 2026-09-26 用户定调：达人邀约与技能启用/停用撤出确认名单（由用户在对话里发起即视为确认）。
   * 但**风险等级不能跟着降级** —— 以前两者都从确认集合推 risk，撤一个就等于把它降成 read
   * （只读执行者能接、`side_effect_started` 不置位、允许"安全恢复"重放重复发送）。
   */
  it('撤出确认名单的动作仍是副作用动作：risk 与确认分开判定', () => {
    for (const type of ['runInvite', 'updateSkill']) {
      expect(AGENT_CONFIRM_REQUIRED_ACTIONS.has(type), `${type} 不应再要求确认`).toBe(false)
      expect(softwareActionHasSideEffect(type), `${type} 仍必须算副作用（risk=write）`).toBe(true)
    }
    // 确认集合是副作用集合的子集（允许"有副作用但不确认"的例外，不允许反向）
    for (const type of AGENT_CONFIRM_REQUIRED_ACTIONS) {
      expect(softwareActionHasSideEffect(type), `${type} 在确认名单里就必须算副作用`).toBe(true)
    }
    // 只读动作两边都不在
    for (const type of ['listStores', 'collectBusiness', 'collectOrders', 'overviewStats']) {
      expect(softwareActionHasSideEffect(type), `${type} 不该算副作用`).toBe(false)
      expect(AGENT_CONFIRM_REQUIRED_ACTIONS.has(type), `${type} 不该要求确认`).toBe(false)
    }
    // 技能步骤禁入清单独立于确认名单：撤出确认不会让它们变成合法技能步骤
    expect(skillStepEligible('runInvite')).toBe(false)
    expect(skillStepEligible('updateSkill')).toBe(false)
  })

  it('skill steps still exclude job control, plugin/task management and memory maintenance', () => {
    for (const type of ['getJobDetail', 'qualityMetrics', 'qualityReview', 'overviewStats', 'overviewDatacenter', 'overviewInvoiceCenter']) {
      expect(skillStepEligible(type), `${type} 是只读工具，应可用于技能`).toBe(true)
    }
    for (const type of ['approveJob', 'reviewJobResult', 'cancelJob', 'updatePlugin', 'deletePlugin', 'updateTask', 'updateAgent', 'applyEntity', 'jobFeedback', 'resumeJob', 'memoryRebuild', 'memorySnapshot']) {
      expect(skillStepEligible(type), `${type} 不该出现在技能步骤里`).toBe(false)
    }
    // isSkillStepAllowed 只回答「嵌套管理/维护类」这一个问题；确认门禁类由 skillStepEligible 叠加判定
    for (const type of ['jobFeedback', 'resumeJob', 'memoryRebuild', 'memorySnapshot', 'createSkill', 'listTools']) {
      expect(isSkillStepAllowed(type), `${type} 属于禁止嵌套的维护/管理动作`).toBe(false)
    }
  })

  it('plugin update/delete inputs must locate a plugin and ask for a real change', () => {    // 定位：pluginId 或 name 至少一个
    expect(agentPluginUpdateInputSchema.safeParse({ newName: '新名字' }).success).toBe(false)
    expect(agentPluginDeleteInputSchema.safeParse({}).success).toBe(false)
    // 变更：改名/说明/成员至少一项，否则就是空提交
    expect(agentPluginUpdateInputSchema.safeParse({ pluginId: 'plugin_1' }).success).toBe(false)
    expect(agentPluginUpdateInputSchema.safeParse({ name: '巡检包', description: '只读巡检' }).success).toBe(true)
    expect(agentPluginUpdateInputSchema.safeParse({ pluginId: 'plugin_1', skillNames: ['每日巡检'] })).toEqual({ success: true, data: { pluginId: 'plugin_1', skillNames: ['每日巡检'] } })
    expect(agentPluginDeleteInputSchema.parse({ name: '巡检包' })).toEqual({ name: '巡检包' })
    // 与模型动作一致：多余字段一律拒绝（面板/模型都不能塞 script 之类的字段进来）
    expect(agentPluginUpdateInputSchema.safeParse({ pluginId: 'plugin_1', newName: 'x', script: 'rm -rf /' }).success).toBe(false)
    expect(agentPluginDeleteInputSchema.safeParse({ pluginId: 'plugin_1', force: true }).success).toBe(false)
    expect(agentPluginUpdateInputSchema.safeParse({ pluginId: 'plugin_1', skillNames: [] }).success).toBe(false)
  })

  // 渲染层（计划卡）要动作中文名，但不能引 @shared/agent-tools（会连带 node:crypto，浏览器构建失败），
  // 所以另有一份纯数据表。这条契约保证两份永远一致：漂移就会在这里失败。
  it('browser-safe label table matches the catalog byte for byte', () => {
    expect(Object.keys(AGENT_TOOL_LABELS).sort()).toEqual(AGENT_TOOL_CATALOG.map(tool => tool.type).sort())
    for (const tool of AGENT_TOOL_CATALOG) {
      expect(AGENT_TOOL_LABELS[tool.type], `${tool.type} 的中文名与目录不一致`).toBe(tool.label)
    }
  })
})

function hasEmptyLeaf(value: unknown): boolean {
  if (typeof value === 'string') return value === ''
  if (Array.isArray(value)) return value.some(hasEmptyLeaf)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasEmptyLeaf)
  return false
}
