/**
 * 模型请求体的**唯一构造点** - §27.2
 *
 * 2026-09-26 审计 P2（"`temperature/max_tokens` 有 4 处独立请求体构造点"）：原先
 * `ai-client.ts`、`agent-runtime.ts` 的对话/Job/健康检查各写一份
 * `body: JSON.stringify({ model, messages, temperature, max_tokens })`。后果是换协议、
 * 加 provider 专属字段（response_format / stop / 新版 max_completion_tokens）时必须逐个改，
 * 漏一处就是"某条链路悄悄用旧协议"——而且各处已经出现了细微不一致（Job 路径少了 stream:false、
 * 头部大小写不同）。
 *
 * 现在所有出站聊天请求都经由本文件：
 *   · `buildChatRequestBody` 决定**字段名与取值口径**；
 *   · `buildChatRequestHeaders` 决定鉴权头；
 *   · `clampMaxOutputTokens` 统一最大输出上限（各区间的下限/默认仍是调用方策略）。
 *
 * 纯函数、无 electron/db 依赖，可直接单测；`tests/unit/model-request.test.ts` 另有源码级
 * 守卫：除本文件外，Main 里不得再出现手写的 `max_tokens` 请求体。
 */

/** OpenAI 兼容协议里最大输出字段名（换协议只改这里） */
export const MAX_OUTPUT_FIELD = 'max_tokens'
/** 最大输出上限：防止把 profile 里填错的巨大值原样发出去 */
export const MAX_OUTPUT_TOKENS_CEILING = 128000
/** 默认温度：与历史实现（ai-client 的 0.7）一致，避免行为漂移 */
export const DEFAULT_TEMPERATURE = 0.7

export interface ChatRequestBodyInput {
  model: string
  system: string
  user: string
  /** 省略/非有限数时回退 DEFAULT_TEMPERATURE */
  temperature?: number | null
  /** 本次请求的最大输出 token（先经 clampMaxOutputTokens 收敛） */
  maxTokens: number
  /** 默认 false：非流式响应（历史实现也是这样，显式写出来省得依赖服务端默认） */
  stream?: boolean
}

/**
 * 构造 OpenAI 兼容的 /chat/completions 请求体。
 * 字段顺序固定，便于对比不同链路抓到的请求。
 */
export function buildChatRequestBody(input: ChatRequestBodyInput): Record<string, unknown> {
  // 注意：Number(null) === 0，必须先判 nullish，否则"没传温度"会变成"温度 0"（实测被这个绊过）
  const raw = input.temperature
  const temperature = raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? DEFAULT_TEMPERATURE : Number(raw)
  const maxTokens = clampMaxOutputTokens(input.maxTokens, 1)
  return {
    model: String(input.model),
    messages: [
      { role: 'system', content: String(input.system ?? '') },
      { role: 'user', content: String(input.user ?? '') }
    ],
    temperature,
    [MAX_OUTPUT_FIELD]: maxTokens,
    stream: input.stream === true
  }
}

/** 鉴权与内容类型头（统一小写，避免同一应用里两套写法） */
export function buildChatRequestHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
}

/** 最大输出收敛：[min, min(max, MAX_OUTPUT_TOKENS_CEILING)]；非数字按 min 处理（如实少要，不多要） */
export function clampMaxOutputTokens(value: number, min: number, max = MAX_OUTPUT_TOKENS_CEILING): number {
  const n = Number(value)
  const safe = Number.isFinite(n) ? Math.round(n) : min
  return Math.max(min, Math.min(Math.max(min, max), safe))
}
