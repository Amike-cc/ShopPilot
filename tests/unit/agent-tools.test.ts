import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_CATALOG, buildToolWhitelistText, isSkillStepAllowed, toolApprovalRequired } from '@shared/agent-tools'
import { AGENT_SOFTWARE_ACTION_TYPES, agentSoftwareActionSchema, agentSkillSchema } from '@shared/schemas/agent'

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
})
