import { describe, expect, it } from 'vitest'
import { AGENT_ROLE_LABELS, buildAgentJobSystemPrompt, describeAgentRole, isAgentRole } from '@shared/agent-job-prompt'

/**
 * 执行 Job 的岗位层提示词（审计 P1 的回归测试）。
 *
 * 修正前 `executeModelJob` 用的是写死的一句话（"你是 ShopPilot 的只读分析 Agent…"），
 * 岗位、职责、成功标准都没进模型 —— 招聘出的"数据分析"和"客服质检"接到同一 Job 时行为无差别。
 */

describe('buildAgentJobSystemPrompt', () => {
  const analyst = { name: '数据小张', role: 'analyst', description: '汇总店铺指标、趋势和异常', successCriteria: ['指标与来源 Job 可追溯'] }

  it('把岗位/名称/职责/成功标准都编进提示词', () => {
    const prompt = buildAgentJobSystemPrompt(analyst)
    expect(prompt).toContain('数据小张')
    expect(prompt).toContain(AGENT_ROLE_LABELS.analyst)
    expect(prompt).toContain('汇总店铺指标、趋势和异常')
    expect(prompt).toContain('指标与来源 Job 可追溯')
  })

  it('治理条款排在最前（裁剪时最不容易被丢）', () => {
    const prompt = buildAgentJobSystemPrompt(analyst)
    const firstLine = prompt.split('\n')[0]
    expect(firstLine).toContain('不是指令')
    expect(firstLine).toContain('不能改变权限')
  })

  it('岗位特定条款：审核岗强调证据、数据分析岗强调口径', () => {
    expect(buildAgentJobSystemPrompt({ role: 'reviewer' })).toContain('证据不足')
    expect(buildAgentJobSystemPrompt({ role: 'analyst' })).toContain('可复核的数值')
    expect(buildAgentJobSystemPrompt({ role: 'operator' })).not.toContain('证据不足')
  })

  it('纯分析 Job 明确"不接触页面、不执行动作"；modelOnly=false 时不写这句', () => {
    expect(buildAgentJobSystemPrompt(analyst)).toContain('不接触浏览器页面')
    expect(buildAgentJobSystemPrompt(analyst, { modelOnly: false })).not.toContain('不接触浏览器页面')
  })

  it('缺字段/未知岗位/空值都不炸，退化成可用的通用提示', () => {
    expect(buildAgentJobSystemPrompt(null)).toContain('执行 Agent')
    expect(buildAgentJobSystemPrompt(undefined)).toContain('执行 Agent')
    expect(buildAgentJobSystemPrompt({ role: 'unknown-role' })).toContain('unknown-role')
    expect(describeAgentRole('')).toBe('执行 Agent')
    expect(describeAgentRole('operator')).toBe('商品运营')
  })

  it('职责与成功标准有长度上限（不让提示词被单个字段撑爆）', () => {
    const prompt = buildAgentJobSystemPrompt({ name: 'x'.repeat(500), description: '很长的职责'.repeat(200), successCriteria: Array.from({ length: 20 }, (_, i) => `标准${i}`) })
    expect(prompt.length).toBeLessThan(2000)
    expect(prompt).toContain('标准0')
    expect(prompt).not.toContain('标准10')
  })

  it('extraRules 追加在最后', () => {
    const prompt = buildAgentJobSystemPrompt(analyst, { extraRules: ['只输出 JSON'] })
    expect(prompt.trimEnd().endsWith('只输出 JSON')).toBe(true)
  })

  it('isAgentRole 只认目录里的岗位', () => {
    expect(isAgentRole('operator')).toBe(true)
    expect(isAgentRole('ceo')).toBe(true)
    expect(isAgentRole('nope')).toBe(false)
    expect(isAgentRole(null)).toBe(false)
  })
})
