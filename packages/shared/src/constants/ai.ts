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

/** 超时可配范围（毫秒） */
export const AI_TIMEOUT_MIN_MS = 3000
export const AI_TIMEOUT_MAX_MS = 120000

/** 设置键（非敏感项走明文 app_settings；key 走 safeStorage 的 ai_cred.key） */
export const AI_SETTING_KEYS = {
  endpoint: 'ai.endpoint',
  model: 'ai.model',
  timeoutMs: 'ai.timeoutMs'
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
  const ep = normalizeAiEndpoint(chatUrl)
  if (!ep) return null
  const m = /^(.*)\/chat\/completions$/i.exec(ep) || /^(.*)\/completions$/i.exec(ep)
  if (!m) return null
  return `${m[1]}/models`
}
