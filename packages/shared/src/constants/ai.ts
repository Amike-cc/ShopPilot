/**
 * 大模型（AI）配置常量 - §4.4
 * 主进程（ai-client）与渲染层（设置界面）共用，避免两处默认值漂移。
 *
 * 协议：OpenAI 兼容的 /chat/completions（DeepSeek / 通义 / Kimi / 智谱 / OpenAI 等均可）。
 * 安全：API Key 只在主进程 safeStorage 内，界面只显示"是否已配置"。
 */

export const DEFAULT_AI_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'
export const DEFAULT_AI_MODEL = 'deepseek-chat'
export const DEFAULT_AI_TIMEOUT_MS = 30000

/** 超时可配范围（毫秒） */
export const AI_TIMEOUT_MIN_MS = 3000
export const AI_TIMEOUT_MAX_MS = 120000

/** 设置键（非敏感项走明文 app_settings；Key 走 safeStorage 的 ai_cred.key） */
export const AI_SETTING_KEYS = {
  endpoint: 'ai.endpoint',
  model: 'ai.model',
  timeoutMs: 'ai.timeoutMs'
} as const

/** 达人广场地址覆盖表（按平台名），留空表示用平台档案里的内置默认 */
export const INVITE_SQUARE_URLS_SETTING = 'invite.squareUrls'
