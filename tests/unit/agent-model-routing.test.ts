import { describe, expect, it } from 'vitest'
import { modelCapabilityVerdict } from '@shared/agent-domain-rules'

/**
 * 2026-09-26 审计 P2-A：能力探测结果以前只落库/只显示，不参与路由。
 * 口径由**真机验收校准**：只有 `chat:false` 才拦路由；`json:false` 只是弱信号
 * （离线 fixture 与部分真实 Profile 的探测结果就是 json:false，实测能跑通 Job），
 * 一律拦会把可用模型全挡在门外——这条回归测试就是那次 8 项验收失败的护栏。
 */
describe('modelCapabilityVerdict（能力探测参与路由）', () => {
  it('从未探测 / 空值一律放行（不能因为"没测过"就不用）', () => {
    for (const value of [undefined, null, {}, { chat: true }, { json: true }, { vision: false }, 'nonsense', 42, []]) {
      expect(modelCapabilityVerdict(value).usable, JSON.stringify(value)).toBe(true)
    }
  })

  it('探测出不能对话（完全没有文本）→ 拦下并给出可操作原因', () => {
    const verdict = modelCapabilityVerdict({ chat: false, json: true })
    expect(verdict.usable).toBe(false)
    expect(verdict.code).toBe('AGENT_MODEL_INCAPABLE')
    expect(verdict.reason).toContain('对话能力探测')
    expect(verdict.reason).toContain('设置 → 模型')
  })

  it('json:false 不拦路由，只给 warning（弱信号，实测仍可跑通）', () => {
    const verdict = modelCapabilityVerdict({ chat: true, json: false })
    expect(verdict.usable).toBe(true)
    expect(verdict.code).toBeUndefined()
    expect(verdict.warning).toContain('JSON')
  })

  it('离线 fixture 的能力形状（chat:true + json:false）必须可用', () => {
    expect(modelCapabilityVerdict({ chat: true, json: false, vision: false, cancellation: true }).usable).toBe(true)
  })

  it('chat:false 优先于 json:false（连通性都没过时先报这一条）', () => {
    const verdict = modelCapabilityVerdict({ chat: false, json: false })
    expect(verdict.usable).toBe(false)
    expect(verdict.reason).toContain('对话能力探测')
  })

  it('探测结论为 true 或只有无关字段时放行（vision 不影响文本路由）', () => {
    expect(modelCapabilityVerdict({ chat: true, json: true }).usable).toBe(true)
    expect(modelCapabilityVerdict({ cancellation: true, vision: false }).usable).toBe(true)
  })
})
