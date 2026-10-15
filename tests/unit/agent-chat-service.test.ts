import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  getAgentContextBudget: vi.fn(),
  chatCompleteForAgent: vi.fn()
}))

vi.mock('../../apps/desktop/src/main/services/agent-runtime', () => runtime)

import { generateAgentChat } from '../../apps/desktop/src/main/services/agent-chat-service'

describe('plain Agent conversation service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.getAgentContextBudget.mockReturnValue({ historyChars: 4000, outputTokens: 800 })
    runtime.chatCompleteForAgent.mockResolvedValue({ text: '你好，我可以和你讨论这个问题。', model: 'fixture-chat', elapsedMs: 17 })
  })

  it('sends only conversation history and the current message to the model', async () => {
    const result = await generateAgentChat({
      message: '你好',
      history: [{ role: 'user', text: '嗨' }, { role: 'assistant', text: '你好。' }]
    })

    expect(runtime.chatCompleteForAgent).toHaveBeenCalledTimes(1)
    const [agentId, request] = runtime.chatCompleteForAgent.mock.calls[0]
    expect(agentId).toBe('root-ceo')
    expect(request.system).toContain('普通中文对话助手')
    expect(request.system).toContain('没有查看或操作店铺')
    expect(request.system).toContain('不输出 JSON、工具调用、操作计划')
    expect(request).not.toHaveProperty('tools')
    expect(request).not.toHaveProperty('imageDataUrl')
    expect(Object.keys(JSON.parse(request.user))).toEqual(['conversationHistory', 'currentMessage'])
    expect(JSON.parse(request.user).currentMessage).toBe('你好')
    expect(result).toEqual({ text: '你好，我可以和你讨论这个问题。', model: 'fixture-chat', elapsedMs: 17 })
  })

  it('rejects operation context fields instead of silently forwarding them', async () => {
    await expect(generateAgentChat({ message: '查看商品', stores: [{ id: 'store-1' }] }))
      .rejects.toMatchObject({ name: 'ZodError' })
    await expect(generateAgentChat({ message: '运行任务', actions: [{ type: 'runTask' }] }))
      .rejects.toMatchObject({ name: 'ZodError' })
    expect(runtime.chatCompleteForAgent).not.toHaveBeenCalled()
  })

  it('does not send direct store-operation commands to a model', async () => {
    const result = await generateAgentChat({ message: '帮我查看当前店铺的商品状态' })
    expect(result.text).toContain('只提供文字对话')
    expect(runtime.chatCompleteForAgent).not.toHaveBeenCalled()
  })

  it('still answers how-to questions and redacts sensitive values from history', async () => {
    runtime.chatCompleteForAgent.mockResolvedValue({ text: '可以按页面里的商品列表筛选。', model: 'fixture-chat', elapsedMs: 4 })
    await generateAgentChat({
      message: '怎么查看当前店铺的商品状态？',
      history: [{ role: 'user', text: '旧 Key 是 sk-proj-1234567890abcdefghijklmnop' }]
    })
    const request = runtime.chatCompleteForAgent.mock.calls[0][1]
    expect(JSON.parse(request.user).conversationHistory[0].text).toContain('[密钥已隐藏]')
  })

  it('returns plain text only and redacts sensitive model output', async () => {
    runtime.chatCompleteForAgent.mockResolvedValue({ text: '请使用 sk-proj-1234567890abcdefghijklmnop', model: 'fixture-chat', elapsedMs: 2 })
    const result = await generateAgentChat({ message: '这是什么密钥？' })
    expect(result.text).toContain('[密钥已隐藏]')
    expect(result).not.toHaveProperty('actions')
    expect(result).not.toHaveProperty('executed')
    expect(result).not.toHaveProperty('jobIds')
  })
})
