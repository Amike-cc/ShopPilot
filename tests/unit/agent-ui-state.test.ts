import { describe, expect, it } from 'vitest'
import {
  AGENT_CONVERSATION_HISTORY_MAX,
  AGENT_UI_MESSAGE_TEXT_MAX,
  DEFAULT_AGENT_UI_STATE,
  agentConversationTurnSchema,
  agentUiMessageSummarySchema,
  agentUiStateSchema
} from '@shared/schemas/agent'

/**
 * 回归锁：UI 状态里持久化的单条正文，决定**重启后模型还能看到多少旧对话**。
 * 重载路径用 messageSummaries 直接重建 messages（renderer stores/agent.ts），
 * 所以这里的上限一旦比进模型的单轮上限小，重启就会无声地砍掉上下文——历史上
 * 是 200 对 2000，等于重启即 10 倍塌缩（长结论只剩开头一句）。
 */
describe('Agent UI 状态持久化的正文上限', () => {
  it('上限与进模型的单轮上限一致，不会有一侧悄悄截断', () => {
    expect(AGENT_UI_MESSAGE_TEXT_MAX).toBe(2000)
    const turn = agentConversationTurnSchema.parse({ role: 'assistant', text: '中'.repeat(AGENT_UI_MESSAGE_TEXT_MAX) })
    expect(turn.text).toHaveLength(AGENT_UI_MESSAGE_TEXT_MAX)
  })

  it('整条正文都能持久化并通过校验', () => {
    const long = '结论：'.repeat(700).slice(0, AGENT_UI_MESSAGE_TEXT_MAX)
    expect(long).toHaveLength(AGENT_UI_MESSAGE_TEXT_MAX)
    const state = agentUiStateSchema.parse({
      ...DEFAULT_AGENT_UI_STATE,
      messageSummaries: [{ role: 'assistant', summary: long, at: 1 }]
    })
    expect(state.messageSummaries[0].summary).toHaveLength(AGENT_UI_MESSAGE_TEXT_MAX)
  })

  it('超限直接拒绝而不是静默截断（超限说明写入方越界了）', () => {
    expect(() => agentUiMessageSummarySchema.parse({ role: 'assistant', summary: 'x'.repeat(AGENT_UI_MESSAGE_TEXT_MAX + 1), at: 1 })).toThrow()
    expect(() => agentUiStateSchema.parse({
      ...DEFAULT_AGENT_UI_STATE,
      messageSummaries: Array.from({ length: AGENT_CONVERSATION_HISTORY_MAX + 1 }, (_, index) => ({ role: 'user' as const, summary: 'x', at: index }))
    })).toThrow()
  })

  it('旧快照（200 字摘要）依旧合法，向后兼容', () => {
    const legacy = agentUiStateSchema.parse({
      ...DEFAULT_AGENT_UI_STATE,
      messageSummaries: [{ role: 'user', summary: 'x'.repeat(200), at: 1 }]
    })
    expect(legacy.messageSummaries).toEqual([{ role: 'user', summary: 'x'.repeat(200), at: 1 }])
  })
})
