import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildChatRequestBody, buildChatRequestHeaders, clampMaxOutputTokens,
  DEFAULT_TEMPERATURE, MAX_OUTPUT_TOKENS_CEILING
} from '../../apps/desktop/src/main/services/model-request'

/**
 * 2026-09-26 审计 P2「temperature/max_tokens 有 4 处独立请求体构造点」：
 * 所有出站聊天请求统一走 model-request.ts；这里锁死字段名与取值口径，
 * 并用源码级守卫防止有人再手写第五份请求体。
 */

describe('buildChatRequestBody（唯一请求体构造点）', () => {
  it('字段齐全且顺序稳定：model / messages / temperature / max_tokens / stream', () => {
    const body = buildChatRequestBody({ model: 'm1', system: 'S', user: 'U', temperature: 0.3, maxTokens: 400 })
    expect(Object.keys(body)).toEqual(['model', 'messages', 'temperature', 'max_tokens', 'stream'])
    expect(body.model).toBe('m1')
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(400)
    // 默认非流式：显式写出来，不依赖服务端默认
    expect(body.stream).toBe(false)
  })

  it('温度缺省或非有限数回退默认值（不发出 NaN/undefined）', () => {
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 10 }).temperature).toBe(DEFAULT_TEMPERATURE)
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 10, temperature: NaN }).temperature).toBe(DEFAULT_TEMPERATURE)
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 10, temperature: null }).temperature).toBe(DEFAULT_TEMPERATURE)
    // 温度 0（健康检查）必须保留 0，不能被当成"缺省"
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 10, temperature: 0 }).temperature).toBe(0)
  })

  it('max_tokens 取整且至少 1；system/user 一定是字符串', () => {
    expect(buildChatRequestBody({ model: 'm', system: null as any, user: undefined as any, maxTokens: 12.6 }).max_tokens).toBe(13)
    expect(buildChatRequestBody({ model: 'm', system: null as any, user: undefined as any, maxTokens: 0 }).max_tokens).toBe(1)
    const body = buildChatRequestBody({ model: 'm', system: null as any, user: undefined as any, maxTokens: 12 })
    expect((body.messages as Array<{ content: unknown }>).every(m => typeof m.content === 'string')).toBe(true)
  })

  it('stream 只在显式 true 时为 true', () => {
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 1, stream: true }).stream).toBe(true)
    expect(buildChatRequestBody({ model: 'm', system: '', user: '', maxTokens: 1, stream: false }).stream).toBe(false)
  })

  it('鉴权头统一为 Bearer + JSON（不再有两套大小写写法）', () => {
    expect(buildChatRequestHeaders('sk-x')).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-x' })
  })
})

describe('clampMaxOutputTokens', () => {
  it('区间收敛：低于下限取下限、高于上限取上限（默认上限 128000）', () => {
    expect(clampMaxOutputTokens(10, 64, 1200)).toBe(64)
    expect(clampMaxOutputTokens(5000, 64, 1200)).toBe(1200)
    expect(clampMaxOutputTokens(5000, 16)).toBe(5000)
    expect(clampMaxOutputTokens(MAX_OUTPUT_TOKENS_CEILING * 2, 16)).toBe(MAX_OUTPUT_TOKENS_CEILING)
  })

  it('非数字按"少要"处理（取 min），不产生 NaN；Infinity 同样按 min（宁可少要也不越界）', () => {
    expect(clampMaxOutputTokens(Number.NaN, 16)).toBe(16)
    expect(clampMaxOutputTokens('abc' as any, 64, 1200)).toBe(64)
    expect(clampMaxOutputTokens(Infinity, 16)).toBe(16)
    expect(clampMaxOutputTokens(Infinity, 16, 1200)).toBe(16)
  })

  it('min/max 传反了也不越界', () => {
    expect(clampMaxOutputTokens(100, 1200, 64)).toBe(1200)
  })
})

describe('源码级守卫：不得再出现手写的聊天请求体', () => {
  const mainServices = new URL('../../apps/desktop/src/main/services/', import.meta.url)
  const files = ['ai-client.ts', 'agent-runtime.ts']

  it('只有 model-request.ts 能出现 max_tokens 请求体字段', () => {
    for (const file of files) {
      const text = readFileSync(new URL(file, mainServices), 'utf8')
      // 允许注释里提到 max_tokens，但不允许对象字面量里的 `max_tokens:`
      expect(text, file).not.toMatch(/max_tokens\s*:/)
      expect(text, file).not.toMatch(/max_completion_tokens\s*:/)
    }
  })

  it('出站聊天请求都经由 buildChatRequestBody + buildChatRequestHeaders', () => {
    for (const file of files) {
      const text = readFileSync(new URL(file, mainServices), 'utf8')
      expect(text, file).toContain("from './model-request'")
      expect(text, file).toMatch(/buildChatRequestBody\(/)
    }
    // ai-client 只有一个出站 POST；agent-runtime 有三处（对话 / Job / 健康检查）
    const runtime = readFileSync(new URL('agent-runtime.ts', mainServices), 'utf8')
    expect(runtime.match(/buildChatRequestBody\(/g)?.length).toBe(3)
  })
})
