import { describe, it, expect } from 'vitest'
import { normalizeAiEndpoint, modelsUrlFromChat, AI_PROVIDER_PRESETS } from '../../packages/shared/src/constants/ai'

// 中转站/自建网关常只给"基础地址"：这次要支持"基础地址"与"完整地址"两种填法
describe('AI 接口地址规范化（支持中转站基础地址）', () => {
  it('基础地址按 OpenAI 通行约定补全', () => {
    expect(normalizeAiEndpoint('https://api.xxx.com')).toBe('https://api.xxx.com/v1/chat/completions')
    expect(normalizeAiEndpoint('https://api.xxx.com/')).toBe('https://api.xxx.com/v1/chat/completions')
    expect(normalizeAiEndpoint('https://api.xxx.com/v1')).toBe('https://api.xxx.com/v1/chat/completions')
    expect(normalizeAiEndpoint('https://api.xxx.com/v1/')).toBe('https://api.xxx.com/v1/chat/completions')
  })

  it('带自定义前缀/版本段的中转站地址也补得对', () => {
    expect(normalizeAiEndpoint('https://gateway.corp.com/openai/v1')).toBe('https://gateway.corp.com/openai/v1/chat/completions')
    expect(normalizeAiEndpoint('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(normalizeAiEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
  })

  it('完整地址原样保留（含 /completions 结尾）', () => {
    expect(normalizeAiEndpoint('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(normalizeAiEndpoint('https://api.xxx.com/chat/completions')).toBe('https://api.xxx.com/chat/completions')
    expect(normalizeAiEndpoint('https://api.xxx.com/v1/completions')).toBe('https://api.xxx.com/v1/completions')
  })

  it('空白/空串处理', () => {
    expect(normalizeAiEndpoint('')).toBe('')
    expect(normalizeAiEndpoint('   ')).toBe('')
    expect(normalizeAiEndpoint(' https://a.com/v1 ')).toBe('https://a.com/v1/chat/completions')
  })
})

describe('模型列表地址推导', () => {
  it('基础地址与完整地址都能推出 /models', () => {
    expect(modelsUrlFromChat('https://api.xxx.com')).toBe('https://api.xxx.com/v1/models')
    expect(modelsUrlFromChat('https://api.xxx.com/v1')).toBe('https://api.xxx.com/v1/models')
    expect(modelsUrlFromChat('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/models')
    // 贪婪匹配回归：不能截成 …/ai/chat/models
    expect(modelsUrlFromChat('https://host/ai/chat/completions')).toBe('https://host/ai/models')
  })
  it('空地址返回 null（不猜）', () => {
    expect(modelsUrlFromChat('')).toBeNull()
  })
})

describe('服务商预设', () => {
  it('预设地址规范化后都是完整补全地址；含中转站/自定义项', () => {
    for (const p of AI_PROVIDER_PRESETS) {
      if (!p.baseUrl) continue
      expect(normalizeAiEndpoint(p.baseUrl).endsWith('/chat/completions')).toBe(true)
    }
    expect(AI_PROVIDER_PRESETS.some(p => p.key === 'relay')).toBe(true)
  })
})
