import { describe, expect, it } from 'vitest'
import { agentUiStateSchema, DEFAULT_AGENT_UI_STATE } from '@shared/schemas/agent'
import { redactAgentText } from '@shared/agent-privacy'
import { clampOrbPoint, isOrbDrag, snapOrbToNearestEdge } from '../../apps/desktop/src/renderer/src/features/agent/orb-geometry'
import { planStatusForJob, statusForJob } from '../../apps/desktop/src/renderer/src/features/agent/job-status'

describe('Agent UI persistence and orb movement helpers', () => {
  it('maps job and task statuses without pretending blocked work succeeded', () => {
    expect(statusForJob('queued')).toBe('running')
    expect(statusForJob('waiting_confirmation')).toBe('waiting_confirmation')
    expect(statusForJob('succeeded')).toBe('succeeded')
    expect(statusForJob('blocked_permission')).toBe('failed')
    expect(statusForJob('blocked_budget')).toBe('failed')
    expect(statusForJob('recovery_required')).toBe('failed')
    expect(planStatusForJob('queued')).toBe('created')
    expect(planStatusForJob('running')).toBe('running')
    expect(planStatusForJob('succeeded')).toBe('succeeded')
    expect(planStatusForJob('blocked_budget')).toBe('failed')
  })
  it('validates normalized persistent UI state and bounded message summaries', () => {
    const result = agentUiStateSchema.parse({
      ...DEFAULT_AGENT_UI_STATE,
      orbPosition: { x: 0.88, y: 0.9 }, drawerOpen: true,
      messageSummaries: [{ role: 'assistant', summary: '已生成草稿计划', at: 123 }]
    })
    expect(result.drawerOpen).toBe(true)
    expect(result.orbPosition).toEqual({ x: 0.88, y: 0.9 })
    expect(agentUiStateSchema.safeParse({ ...result, orbPosition: { x: 2, y: 0 } }).success).toBe(false)
  })

  it('masks common sensitive values before page text becomes a summary', () => {
    expect(redactAgentText('电话：13800138000，收货地址：北京市朝阳区示例路88号'))
      .toBe('电话：[手机号已隐藏]，收货地址：[地址已隐藏]')
    expect(redactAgentText('sk-proj-1234567890abcdefghijklmnop')).toBe('[密钥已隐藏]')
  })

  it('does not treat sub-threshold movement as a drag, preventing accidental click suppression', () => {
    expect(isOrbDrag(4, 3)).toBe(false)
    expect(isOrbDrag(6, 0)).toBe(false)
    expect(isOrbDrag(6.1, 0)).toBe(true)
  })

  it('clamps the orb within the work area and snaps to the nearest edge while preserving its offset', () => {
    expect(clampOrbPoint({ x: 900, y: -30 }, { x: 300, y: 500 })).toEqual({ x: 300, y: 0 })
    expect(snapOrbToNearestEdge({ x: 275, y: 480 }, { x: 300, y: 500 })).toEqual({ x: 275, y: 500 })
    expect(snapOrbToNearestEdge({ x: 120, y: 245 }, { x: 300, y: 500 })).toEqual({ x: 0, y: 245 })
  })
})
