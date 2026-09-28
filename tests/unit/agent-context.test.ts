import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  compactAgentPrompt,
  compactTextForContext,
  compressAgentHistory,
  describeAgentContextUsage,
  describeResolvedContextWindow,
  estimateAgentChars,
  estimateAgentTokens,
  fitTextToTokens,
  formatAgentTokens,
  mergeAgentContextUsage,
  readAgentContextUsage,
  resolveAgentContextBudget,
  resolveModelContextWindow,
  truncateTextToTokens
} from '@shared/agent-context'

describe('Agent 上下文 token 估算', () => {
  it('按字符类别估算混合中英文/JSON', () => {
    expect(estimateAgentTokens('')).toBe(1)
    expect(estimateAgentTokens('a'.repeat(360))).toBe(100)
    expect(estimateAgentTokens('中'.repeat(135))).toBe(100)
    expect(estimateAgentTokens('中'.repeat(27) + 'a'.repeat(36))).toBe(30)
  })

  it('把假名与扩展区汉字计为 CJK，emoji 不计为 CJK', () => {
    expect(estimateAgentTokens('ア'.repeat(135))).toBe(100) // Katakana
    expect(estimateAgentTokens('あ'.repeat(135))).toBe(100) // Hiragana
    expect(estimateAgentTokens('𠀀'.repeat(135))).toBe(100) // CJK 扩展 B（U+20000）
    expect(estimateAgentTokens('😀'.repeat(36))).toBe(10) // 非 CJK 星平面字符只算一个码点
  })

  it('字符预算永远不超过对应 token 预算（最坏情况全中文）', () => {
    for (const tokens of [64, 512, 4096, 128000]) {
      const chars = estimateAgentChars(tokens)
      expect(chars).toBeGreaterThan(0)
      for (const sample of ['中'.repeat(chars), 'a'.repeat(chars), '中a'.repeat(Math.floor(chars / 2))]) {
        expect(estimateAgentTokens(sample)).toBeLessThanOrEqual(tokens)
      }
    }
  })

  it('truncateTextToTokens 硬性不超 tokens 且保留首尾', () => {
    const raw = `开头-${'中'.repeat(5000)}-结尾`
    const bounded = truncateTextToTokens(raw, 100)
    expect(estimateAgentTokens(bounded)).toBeLessThanOrEqual(100)
    expect(bounded.startsWith('开头-')).toBe(true)
    expect(bounded.endsWith('-结尾')).toBe(true)
    expect(bounded).toContain('…')
    expect(truncateTextToTokens('短文本', 100)).toBe('短文本')
    expect(truncateTextToTokens('', 100)).toBe('')
    expect(estimateAgentTokens(truncateTextToTokens('中'.repeat(500), 16))).toBeLessThanOrEqual(16)
  })
})

describe('模型上下文窗口推断', () => {
  it('Profile override 优先，并夹在 4096～2000000 之间', () => {
    expect(resolveModelContextWindow('openai', 'gpt-4.1', 64000)).toEqual({ tokens: 64000, source: 'override' })
    expect(resolveModelContextWindow('openai', 'gpt-4o', 10_000_000).tokens).toBe(2_000_000)
    // 低于下限的 override 视为未配置，回落到名称/表推断
    expect(resolveModelContextWindow('openai', 'gpt-4o', 1000)).toEqual({ tokens: 128000, source: 'model-name' })
  })

  it('模型名里的 128k/64k 等提示最可信', () => {
    expect(resolveModelContextWindow('custom', 'my-model-128k')).toEqual({ tokens: 128000, source: 'model-name' })
    expect(resolveModelContextWindow('custom', 'deployment-window-64k')).toEqual({ tokens: 64000, source: 'model-name' })
    // 名称提示优先于内置表
    expect(resolveModelContextWindow('custom', 'gpt-4.1-8k')).toEqual({ tokens: 8000, source: 'model-name' })
  })

  it('内置表识别常见模型家族的更高窗口', () => {
    expect(resolveModelContextWindow('openai', 'gpt-4.1-mini').tokens).toBe(1_000_000)
    expect(resolveModelContextWindow('openai', 'gpt-4.1').tokens).toBe(1_000_000)
    expect(resolveModelContextWindow('anthropic', 'claude-3-5-sonnet-20241022').tokens).toBe(200_000)
    expect(resolveModelContextWindow('anthropic', 'claude-4-sonnet').tokens).toBe(200_000)
    expect(resolveModelContextWindow('google', 'gemini-2.5-pro').tokens).toBe(1_000_000)
    expect(resolveModelContextWindow('google', 'gemini-1.5-flash').tokens).toBe(1_000_000)
    expect(resolveModelContextWindow('openai', 'o1').tokens).toBe(200_000)
    expect(resolveModelContextWindow('openai', 'o3-mini').tokens).toBe(200_000)
    expect(resolveModelContextWindow('openai', 'o1-mini').tokens).toBe(128_000)
    expect(resolveModelContextWindow('xai', 'grok-3').tokens).toBe(131_072)
    expect(resolveModelContextWindow('zhipu', 'glm-4-plus').tokens).toBe(128_000)
  })

  it('未知模型仍保守回落默认窗口', () => {
    expect(resolveModelContextWindow('mistralai', 'mixtral-8x7b')).toEqual({ tokens: DEFAULT_MODEL_CONTEXT_TOKENS, source: 'provider-default' })
    expect(resolveModelContextWindow('local', 'my-local-7b')).toEqual({ tokens: DEFAULT_MODEL_CONTEXT_TOKENS, source: 'provider-default' })
    expect(resolveModelContextWindow('deepseek', 'deepseek-chat').tokens).toBe(128000)
  })
})

describe('Agent 上下文预算', () => {
  it('输入/输出/安全边距不超窗口，且子预算不超各自 token 份额', () => {
    const budget = resolveAgentContextBudget({
      provider: 'openai', model: 'gpt-4o', contextWindowTokens: 32768, requestedOutputTokens: 1200, profileMaxTokens: 4000
    })
    expect(budget.source).toBe('override')
    expect(budget.contextWindowTokens).toBe(32768)
    expect(budget.outputTokens).toBe(1200)
    expect(budget.maxInputTokens + budget.outputTokens).toBeLessThanOrEqual(32768 - 1024)
    expect(budget.maxInputChars).toBeGreaterThanOrEqual(budget.historyChars)
    expect(estimateAgentTokens('中'.repeat(budget.historyChars))).toBeLessThanOrEqual(Math.ceil(budget.maxInputTokens * 0.28))
    expect(estimateAgentTokens('中'.repeat(budget.memoryChars))).toBeLessThanOrEqual(Math.ceil(budget.maxInputTokens * 0.18))
    expect(estimateAgentTokens('中'.repeat(budget.jobResultsChars))).toBeLessThanOrEqual(Math.ceil(budget.maxInputTokens * 0.2))
  })

  it('小窗口下最小值兜底仍不超输入预算', () => {
    const budget = resolveAgentContextBudget({
      provider: 'local', model: 'secret-7b', contextWindowTokens: 4096, requestedOutputTokens: 1200, profileMaxTokens: 4000
    })
    expect(budget.maxInputTokens).toBeGreaterThanOrEqual(1024)
    expect(budget.historyChars).toBeLessThanOrEqual(budget.maxInputChars)
    expect(estimateAgentTokens('中'.repeat(budget.historyChars))).toBeLessThanOrEqual(budget.maxInputTokens)
    expect(budget.outputTokens).toBeGreaterThanOrEqual(16)
  })

  it('未配置 Profile 时回落默认窗口', () => {
    const budget = resolveAgentContextBudget({ provider: 'local', model: 'secret-7b' })
    expect(budget.contextWindowTokens).toBe(DEFAULT_MODEL_CONTEXT_TOKENS)
    expect(budget.source).toBe('provider-default')
  })
})

describe('对话历史压缩', () => {
  it('放得下时原样返回，空历史返回空数组', () => {
    const short = [
      { role: 'user' as const, text: '你好' },
      { role: 'assistant' as const, text: '在的' }
    ]
    expect(compressAgentHistory(short, 1200)).toEqual(short)
    expect(compressAgentHistory([], 1200)).toEqual([])
  })

  it('省略旧轮次时按首/中/尾均衡采样摘要，且可复现', () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `轮次${index}：${'中'.repeat(150)}`
    }))
    const result = compressAgentHistory(history, 3000)
    expect(result[0].role).toBe('assistant')
    const summary = result[0].text

    // 采样覆盖省略区间的头/中/尾，而不是只取首条+末三条
    for (const index of [0, 4, 9, 13]) expect(summary).toContain(`轮次${index}：`)
    for (const index of [1, 2, 3, 5, 7, 11]) expect(summary).not.toContain(`轮次${index}：`)

    // 最近轮次保留原文，总量不超预算（与函数内部口径一致：摘要 + 各保留轮次成本）
    const kept = result.slice(1)
    expect(kept).toEqual(history.slice(history.length - kept.length))
    const used = result[0].text.length + kept.reduce((total, turn) => total + turn.text.length + 24, 0)
    expect(used).toBeLessThanOrEqual(3000)

    // 「已省略 N 轮」的数字与最终保留轮次一致
    expect(summary).toContain(`已省略 ${history.length - kept.length} 轮`)

    expect(compressAgentHistory(history, 3000)).toEqual(result)
  })
})

describe('模型请求 JSON 压缩', () => {
  it('放得下时原样返回', () => {
    const small = JSON.stringify({ goal: '检查店铺', actions: [] })
    expect(compactAgentPrompt(small, 500)).toBe(small)
  })

  it('超预算时保持合法 JSON，并优先保住 goal/instruction', () => {
    const heavy = JSON.stringify({
      goal: '目标'.repeat(400),
      notes: 'x'.repeat(20000),
      stores: Array.from({ length: 120 }, (_, index) => ({ id: `store-${index}`, name: `店铺${index}`, platform: 'douyin' }))
    })
    const bounded = compactAgentPrompt(heavy, 400)
    expect(bounded).not.toBe(heavy)
    expect(estimateAgentTokens(bounded)).toBeLessThanOrEqual(400)
    const parsed = JSON.parse(bounded) as { goal: string; notes: string; stores: unknown[] }
    // 同等预算下高优先级字段保留的 token 应多于低优先级字段
    expect(estimateAgentTokens(parsed.goal)).toBeGreaterThan(estimateAgentTokens(parsed.notes))
    expect(parsed.stores.length).toBeLessThan(120)
  })

  it('额外字段被压缩后仍是合法 JSON 且不超预算', () => {
    const heavy = JSON.stringify({
      goal: '继续处理任务',
      instruction: '未达成就给出下一步',
      conversationHistory: Array.from({ length: 40 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: `第${index}轮：${'中'.repeat(200)}` })),
      approvedMemory: '记忆'.repeat(2000),
      stores: Array.from({ length: 300 }, (_, index) => ({ id: `s${index}`, name: `店铺${index}` })),
      jobs: Array.from({ length: 200 }, (_, index) => ({ id: `j${index}`, goal: `目标${index}`.repeat(30) }))
    })
    const bounded = compactAgentPrompt(heavy, 600)
    expect(estimateAgentTokens(bounded)).toBeLessThanOrEqual(600)
    const parsed = JSON.parse(bounded) as { goal: string; conversationHistory: unknown[] }
    expect(parsed.goal.length).toBeGreaterThan(0)
    expect(Array.isArray(parsed.conversationHistory)).toBe(true)
  })

  it('非 JSON 文本退化为有界截断，不超预算', () => {
    const raw = '中'.repeat(5000)
    const bounded = compactAgentPrompt(raw, 120)
    expect(bounded).not.toBe(raw)
    expect(estimateAgentTokens(bounded)).toBeLessThanOrEqual(128)
    expect(bounded).toContain('…')
  })
})

describe('展示用的 token 计数', () => {
  it('按量级压缩，越界输入不显示成负数或 NaN', () => {
    expect(formatAgentTokens(0)).toBe('0')
    expect(formatAgentTokens(Number.NaN)).toBe('0')
    expect(formatAgentTokens(-5)).toBe('0')
    expect(formatAgentTokens(512)).toBe('512')
    expect(formatAgentTokens(1000)).toBe('1k')
    expect(formatAgentTokens(1500)).toBe('1.5k')
    expect(formatAgentTokens(32768)).toBe('32.8k')
    expect(formatAgentTokens(128000)).toBe('128k')
    expect(formatAgentTokens(1_000_000)).toBe('1M')
    expect(formatAgentTokens(2_000_000)).toBe('2M')
  })

  it('面板必须显示出数值与来源，而不是只写“自动推导”', () => {
    expect(describeResolvedContextWindow(128000, 'model-name')).toBe('128k（按模型名推导）')
    expect(describeResolvedContextWindow(8192, 'override')).toBe('8.2k（手动）')
    expect(describeResolvedContextWindow(32768, 'provider-default')).toBe('32.8k（兜底默认）')
    expect(describeResolvedContextWindow(0, 'provider-default')).toBe('未知')
    expect(describeResolvedContextWindow(undefined, undefined)).toBe('未知')
  })
})

describe('真实上下文用量（来自服务商 usage）', () => {
  it('累加多轮成本，同时保留单次峰值作为窗口水位', () => {
    const first = readAgentContextUsage({ usage: { prompt_tokens: 3000, completion_tokens: 200 } }, 128000, 120000)
    expect(first).toMatchObject({ calls: 1, inputTokens: 3000, outputTokens: 200, peakInputTokens: 3000, usageReported: true })

    const second = readAgentContextUsage({ usage: { prompt_tokens: 5200, completion_tokens: 300 } }, 128000, 120000)
    const total = mergeAgentContextUsage(first, second)
    expect(total.calls).toBe(2)
    expect(total.inputTokens).toBe(8200)      // 累加值反映本回合花了多少
    expect(total.outputTokens).toBe(500)
    expect(total.peakInputTokens).toBe(5200)  // 峰值才反映窗口被占了多少
    expect(total.contextWindowTokens).toBe(128000)
    expect(total.maxInputTokens).toBe(120000)

    const text = describeAgentContextUsage(total)
    expect(text).toContain('2 次调用')
    expect(text).toContain('5.2k / 128k')
    expect(text).toContain('4%')
  })

  it('兼容 input_tokens 命名；服务商没报用量时如实说明而不是显示 0', () => {
    expect(readAgentContextUsage({ usage: { input_tokens: 900, output_tokens: 30 } }, 32768, 30000).inputTokens).toBe(900)
    const missing = readAgentContextUsage({ model: 'x' }, 32768, 30000)
    expect(missing.usageReported).toBe(false)
    expect(missing.inputTokens).toBe(0)
    expect(describeAgentContextUsage(missing)).toContain('未报告')
    // 没有任何调用时不该显示“0 次调用”
    expect(describeAgentContextUsage(mergeAgentContextUsage(missing, readAgentContextUsage({}, 32768, 30000)))).toContain('2 次调用')
  })
})

describe('两遍分配：按 token 预算回填，不再欠填充', () => {
  it('放得下就原样返回，空文本返回空', () => {
    expect(fitTextToTokens('短文本', 100)).toBe('短文本')
    expect(fitTextToTokens('', 100)).toBe('')
  })

  it('无论中英文都不超 token 预算，且保留首尾与截断标记', () => {
    for (const tokens of [32, 128, 512, 2048]) {
      for (const raw of ['中'.repeat(4000), 'a'.repeat(4000), `${'中'.repeat(2000)}${'a'.repeat(2000)}`]) {
        const fitted = fitTextToTokens(raw, tokens)
        expect(estimateAgentTokens(fitted)).toBeLessThanOrEqual(tokens)
        expect(fitted.length).toBeLessThanOrEqual(raw.length)
      }
    }
    const bounded = fitTextToTokens(`开头-${'a'.repeat(4000)}-结尾`, 100)
    expect(bounded.startsWith('开头-')).toBe(true)
    expect(bounded.endsWith('-结尾')).toBe(true)
    expect(bounded).toContain('…')
  })

  it('拉丁内容不再只用到约 1/2.7 的容量（这是欠填充的根因）', () => {
    const latin = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
    const conservative = truncateTextToTokens(latin, 300)
    const fitted = fitTextToTokens(latin, 300)
    expect(estimateAgentTokens(fitted)).toBeLessThanOrEqual(300)
    expect(estimateAgentTokens(conservative)).toBeLessThanOrEqual(300)
    // 保守切片按“全中文”折算字符数，拉丁内容应能装下两倍以上
    expect(fitted.length).toBeGreaterThan(conservative.length * 2)
  })

  it('中文内容维持原口径（最坏情况估算本就贴合，不该虚增）', () => {
    const cjk = '库存低于十件时先看证据再决定补货。'.repeat(200)
    const conservative = truncateTextToTokens(cjk, 400)
    const fitted = fitTextToTokens(cjk, 400)
    expect(estimateAgentTokens(fitted)).toBeLessThanOrEqual(400)
    expect(fitted.length).toBeLessThan(conservative.length * 1.5)
  })

  it('compactTextForContext 用同一个 token 份额，拉丁正文不再被白扔', () => {
    const latin = 'evidence: '.repeat(2000)
    const maxChars = estimateAgentChars(1500)      // 预算侧给出的保守字符份额
    const fitted = compactTextForContext(latin, maxChars)
    expect(estimateAgentTokens(fitted)).toBeLessThanOrEqual(1500)
    expect(fitted.length).toBeGreaterThan(maxChars)
  })
})
