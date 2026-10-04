/**
 * 大模型（AI）配置常量 - §4.4
 * 主进程（ai-client）与渲染层（设置界面）共用，避免两处默认值漂移。
 *
 * 协议：OpenAI 兼容 /chat/completions（DeepSeek / 通义 / Kimi / 智谱 / OpenAI / 硅基流动 /
 * OpenRouter / 各类「中转站」聚合网关等均可）。
 * 安全：API Key 只在主进程 safeStorage 内，界面只显示"是否已配置"。
 */

export const DEFAULT_AI_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'
export const DEFAULT_AI_MODEL = 'deepseek-chat'
export const DEFAULT_AI_TIMEOUT_MS = 30000
/**
 * 生图与"生图文本"两条链路单独给更宽的超时。
 *
 * 为什么不能共用 30000（2026-10-03 实测）：一次生图实测 25~40 秒；生图文本模型
 * （如 gpt-6.1-sol）一次卖点分析实测约 25 秒——30 秒默认值正好卡在边界上，
 * 用户看到的是"AI 分析卖点 不能用"（AI_TIMEOUT），但配置其实完全正确。
 */
export const DEFAULT_AI_IMAGE_TIMEOUT_MS = 120000
export const DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS = 120000
/** 生图接口必须显式配置，避免把文本 API 或文本 Key 当成图片服务使用。 */
export const DEFAULT_AI_IMAGE_ENDPOINT = ''
export const DEFAULT_AI_IMAGE_MODEL = ''
/** 商品图片工作台的文本分析 API 也必须显式配置，不继承 Agent 文本配置。 */
export const DEFAULT_AI_IMAGE_TEXT_ENDPOINT = ''
export const DEFAULT_AI_IMAGE_TEXT_MODEL = ''

/** 超时可配范围（毫秒） */
export const AI_TIMEOUT_MIN_MS = 3000
export const AI_TIMEOUT_MAX_MS = 120000

/** 设置键（非敏感项走明文 app_settings；key 走 safeStorage 的 ai_cred.key） */
export const AI_SETTING_KEYS = {
  endpoint: 'ai.endpoint',
  model: 'ai.model',
  timeoutMs: 'ai.timeoutMs'
} as const

/** 图片生成配置与文本配置完全分离；地址可以填基础地址或 /images/generations。 */
export const AI_IMAGE_SETTING_KEYS = {
  endpoint: 'ai.image.endpoint',
  model: 'ai.image.model',
  timeoutMs: 'ai.image.timeoutMs'
} as const

/** AI 生成商品图片页面的卖点分析/提示词整理专用文本 API 配置。 */
export const AI_IMAGE_TEXT_SETTING_KEYS = {
  endpoint: 'ai.imageText.endpoint',
  model: 'ai.imageText.model',
  timeoutMs: 'ai.imageText.timeoutMs'
} as const

/** 达人广场地址覆盖表（按平台名），留空表示用平台档案里的内置默认 */
export const INVITE_SQUARE_URLS_SETTING = 'invite.squareUrls'

/**
 * 服务商预设：**只是便捷预填**（基础地址 + 常见模型名），不代表"只能选这些"——
 * 任何 OpenAI 兼容地址（含中转站/自建网关）都可直接手填。
 * 各家的模型名与可用性以其账号实际为准，这里不保证有效（也不联网探测）。
 */
export interface AiProviderPreset {
  key: string
  label: string
  /** 基础地址（可含 /v1 等版本段；使用时自动规范化为完整补全地址） */
  baseUrl: string
  /** 常见模型名（仅供参考，可用「获取可用模型」拉真实列表后再挑） */
  models: string[]
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  { key: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { key: 'dashscope', label: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { key: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-plus'] },
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: [] },
  { key: 'openrouter', label: 'OpenRouter（聚合）', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  { key: 'relay', label: '中转站 / 自定义（任意 OpenAI 兼容地址）', baseUrl: '', models: [] }
]

/**
 * 把用户填的地址规范化为**完整的补全地址**。中转站/自建网关给的通常是"基础地址"
 * （如 `https://api.xxx.com` 或 `https://api.xxx.com/v1`），此前要求必须填到
 * `/chat/completions` 才可用（否则 /models 推不出来、请求也打到错路径）——现在两种都能填：
 *   https://host                      → https://host/v1/chat/completions
 *   https://host/v1                   → https://host/v1/chat/completions
 *   https://host/v1/                  → https://host/v1/chat/completions
 *   https://host/v1/chat/completions  → 原样
 *   https://host/chat/completions     → 原样
 *   https://host/任意前缀/v1          → https://host/任意前缀/v1/chat/completions
 * 规则是"可预期的拼接"，不是猜测可用性：拼出来的地址照样要经「测试连接」验证。
 */
export function normalizeAiEndpoint(raw: string): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, '').replace(/\/+$/, '')
  if (!s) return ''
  // 已是补全地址（含 /completions 或 /chat/completions）
  if (/\/(chat\/)?completions$/i.test(s)) return s
  // 结尾是版本段（/v1、/v4、/compatible-mode/v1 等）→ 直接补补全路径
  if (/\/(v\d+[a-z]*|compatible-mode\/v\d+)$/i.test(s)) return s + '/chat/completions'
  // 其余（纯域名 / 自定义前缀）→ 按 OpenAI 通行约定补 /v1/chat/completions
  return s + '/v1/chat/completions'
}

/**
 * 由补全地址推导模型列表地址（OpenAI 兼容 GET /models）；推不出来返回 null（不猜）。
 * 两条正则分开写：合并时 (.*) 贪婪会把 "…/ai/chat/completions" 截成 "…/ai/chat"。
 */
export function modelsUrlFromChat(chatUrl: string): string | null {
  const raw = String(chatUrl ?? '').trim().replace(/\/+$/, '')
  // A path that mentions "completions" but is not one of the two supported
  // OpenAI endpoint forms is almost always a typo. Do not normalize it into a
  // different URL and then report a misleading JSON/request failure.
  if (/completions/i.test(raw) && !/\/(chat\/)?completions$/i.test(raw)) return null
  const ep = normalizeAiEndpoint(chatUrl)
  if (!ep) return null
  const m = /^(.*)\/chat\/completions$/i.exec(ep) || /^(.*)\/completions$/i.exec(ep)
  if (!m) return null
  return `${m[1]}/models`
}

/**
 * 由 OpenAI 兼容的 chat/completions 地址推导图片生成地址。
 * 这里只做明确的路径替换，不猜测供应商私有路径；无法推导时返回 null。
 */
export function imageUrlFromChat(chatUrl: string): string | null {
  const raw = String(chatUrl ?? '').trim().replace(/\/+$/, '')
  if (/(^|\/)images\/generations$/i.test(raw)) return raw
  if (/completions/i.test(raw) && !/\/(chat\/)?completions$/i.test(raw)) return null
  const ep = normalizeAiEndpoint(chatUrl)
  if (!ep) return null
  const m = /^(.*)\/chat\/completions$/i.exec(ep) || /^(.*)\/completions$/i.exec(ep)
  if (!m) return null
  return `${m[1]}/images/generations`
}

/**
 * 规范化图片生成地址。图片服务可以单独填写完整的 `/images/generations`，
 * 也可以填写 OpenAI 兼容基础地址或 `/chat/completions` 地址；空值保持空值，
 * 不会回退到文本端点。
 */
export function normalizeImageEndpoint(raw: string): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, '').replace(/\/+$/, '')
  if (!s) return ''
  // 不把供应商的编辑端点或其它私有图片路径猜成生成地址。
  if (/(^|\/)images\//i.test(s) && !/(^|\/)images\/generations$/i.test(s)) return ''
  return imageUrlFromChat(s) || ''
}

/** 从独立图片端点推导只读 `/models` 地址。 */
export function modelsUrlFromImageEndpoint(raw: string): string | null {
  const endpoint = normalizeImageEndpoint(raw)
  if (!endpoint) return null
  return endpoint.replace(/\/images\/generations$/i, '/models')
}

/**
 * 由 OpenAI 兼容的图片生成地址推导图片编辑地址。
 * 只有明确的 `/images/generations` 路径才允许替换，避免把供应商私有路径
 * 猜成一个看似可用但实际错误的上传端点。
 */
export function imageEditUrlFromGeneration(generationUrl: string): string | null {
  const raw = String(generationUrl ?? '').trim().replace(/\/+$/, '')
  if (!/(^|\/)images\/generations$/i.test(raw)) return null
  return raw.replace(/\/images\/generations$/i, '/images/edits')
}
