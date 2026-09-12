/**
 * 大模型客户端（OpenAI 兼容 /chat/completions）- §4.4
 *
 * 位置：只在主进程。渲染层 CSP 是 `connect-src 'self'`，本来就发不出外部请求；
 * API Key 经 safeStorage 加密存储，只在主进程内存中使用，绝不回传渲染层、绝不写日志。
 *
 * 如实声明的边界：
 * - **直连出网，不走店铺代理**（Chromium 的 session 代理管不到主进程 fetch）；
 * - 固定超时（默认 30s，可配 3–120s），失败按固定错误码返回，**不自动重试、不降级、不假装成功**；
 * - 接口地址须为 https://（仅本机 127.0.0.1/localhost 允许 http://，便于接本地模型）；
 * - 「获取可用模型」是只读 GET /models，地址由 /chat/completions 推导，推不出来就如实报错（不猜地址）。
 */

import { getDatabase } from '../db/database'
import { getAiKey, hasAiKey } from './credential-store'
import { logMain } from './logger'

export { DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS } from '@shared/constants/ai'
import { DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS } from '@shared/constants/ai'

export interface AiConfig {
  endpoint: string
  model: string
  timeoutMs: number
  /** 仅告知"是否已配置"，绝不回传 Key 本身 */
  hasKey: boolean
}

export class AiError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

function readSetting(key: string): unknown {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as any
    return row ? JSON.parse(row.value_json) : null
  } catch {
    return null
  }
}

export function getAiConfig(): AiConfig {
  const endpoint = String(readSetting('ai.endpoint') ?? '').trim() || DEFAULT_AI_ENDPOINT
  const model = String(readSetting('ai.model') ?? '').trim() || DEFAULT_AI_MODEL
  const rawTimeout = Number(readSetting('ai.timeoutMs') ?? DEFAULT_AI_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(Math.round(rawTimeout), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS)
    : DEFAULT_AI_TIMEOUT_MS
  return { endpoint, model, timeoutMs, hasKey: hasAiKey() }
}

function assertEndpointUsable(endpoint: string): void {
  if (/^https:\/\//i.test(endpoint)) return
  // 仅本机地址允许 http（接本地模型），其余必须 https —— 避免把 Key 明文发到公网
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(endpoint)
  if (isLoopback) return
  throw new AiError('AI_BAD_ENDPOINT', '接口地址须为 https://（仅 127.0.0.1 / localhost 允许 http://）')
}

export interface AiChatResult { text: string; model: string; elapsedMs: number }

/** 单轮补全。system/user 都由本文件或调用方构造，不接受渲染层传入的任意角色/消息数组。 */
export async function chatComplete(opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<AiChatResult> {
  const cfg = getAiConfig()
  const key = getAiKey()
  if (!key || !key.trim()) throw new AiError('AI_NOT_CONFIGURED', '未配置大模型 API Key（设置 → AI 配置）')
  assertEndpointUsable(cfg.endpoint)

  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ],
        temperature: 0.7,
        max_tokens: Math.max(64, Math.min(1200, opts.maxTokens ?? 400)),
        stream: false
      }),
      signal: ac.signal
    })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new AiError('AI_REQUEST_FAILED', '响应不是合法 JSON')
    }
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new AiError('AI_EMPTY_OUTPUT', '模型返回了空内容')
    return { text, model: String(data?.model || cfg.model), elapsedMs: Date.now() - t0 }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI_TIMEOUT', `请求超过 ${timeoutMs}ms 未返回`)
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally {
    clearTimeout(timer)
  }
}

/** 设置里的「测试连接」：一次最小请求，如实回报成功/失败与耗时 */
export async function testAiConnection(): Promise<{ ok: true; model: string; elapsedMs: number } | { ok: false; code: string; message: string }> {
  try {
    const r = await chatComplete({
      system: '你是连通性测试助手。',
      user: '只回复两个字：可用',
      maxTokens: 16,
      timeoutMs: Math.min(getAiConfig().timeoutMs, 20000)
    })
    logMain('info', `[ai] 测试连接成功 model=${r.model} ${r.elapsedMs}ms`)
    return { ok: true, model: r.model, elapsedMs: r.elapsedMs }
  } catch (e: any) {
    const code = e instanceof AiError ? e.code : 'AI_REQUEST_FAILED'
    const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
    logMain('warn', `[ai] 测试连接失败 ${code}: ${message}`)
    return { ok: false, code, message }
  }
}

/**
 * 从 chat/completions 地址推出 OpenAI 兼容的模型列表地址（`…/models`）。
 * 只在能明确推导时返回——推不出来就如实报错，不猜、不拼一个可能打不通的地址。
 */
export function modelsUrlFor(endpoint: string): string {
  const ep = String(endpoint || '').trim().replace(/\/+$/, '')
  // 必须分成两条正则：合并成 /(chat\/completions|completions)$/ 时，(.*) 贪婪会把
  // "…/ai/chat/completions" 截成 "…/ai/chat" + "/completions"，推出错误的 …/ai/chat/models
  const m = /^(.*)\/chat\/completions$/i.exec(ep) || /^(.*)\/completions$/i.exec(ep)
  if (!m) throw new AiError('AI_BAD_ENDPOINT', '接口地址须以 /chat/completions 结尾，才能推出 /models 地址')
  return `${m[1]}/models`
}

/**
 * 拉取可用模型列表（OpenAI 兼容 GET /models）。
 * 只读接口：失败按固定错误码如实返回，不返回任何编造的模型名。
 * Key 不出主进程，也不进日志。
 */
export async function listModels(): Promise<{ models: string[]; elapsedMs: number }> {
  const cfg = getAiConfig()
  const key = getAiKey()
  if (!key || !key.trim()) throw new AiError('AI_NOT_CONFIGURED', '未配置大模型 API Key（设置 → AI 配置）')
  assertEndpointUsable(cfg.endpoint)
  const url = modelsUrlFor(cfg.endpoint)

  const ac = new AbortController()
  const timeoutMs = Math.min(cfg.timeoutMs, 20000)
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: ac.signal })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new AiError('AI_REQUEST_FAILED', '响应不是合法 JSON')
    }
    // OpenAI 兼容：{ data: [{ id }] }；部分网关直接给数组
    const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null
    if (!arr) throw new AiError('AI_REQUEST_FAILED', '响应里没有模型列表（期望 { data: [{ id }] }）')
    const models = [...new Set(arr.map((x: any) => String(x?.id ?? x?.name ?? x ?? '').trim()).filter(Boolean))].sort()
    if (!models.length) throw new AiError('AI_EMPTY_OUTPUT', '接口没有返回任何可用模型')
    logMain('info', `[ai] 获取可用模型成功 count=${models.length} ${Date.now() - t0}ms`)
    return { models, elapsedMs: Date.now() - t0 }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI_TIMEOUT', `请求超过 ${timeoutMs}ms 未返回`)
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally {
    clearTimeout(timer)
  }
}

/** 清洗模型输出：去引号/标签/多余空白，并夹到 maxLen（平台对邀约话术有字数上限） */
export function cleanScript(raw: string, maxLen: number): string {
  let s = String(raw ?? '')
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/gi, ''))   // 去掉代码块围栏
  s = s.replace(/^\s*(话术|邀约话术|文案|回复)\s*[:：]\s*/i, '')                 // 去掉"话术："之类的前缀
  s = s.replace(/["'“”‘’]/g, '')                                             // 去掉引号
  s = s.replace(/\s+/g, ' ').trim()                                          // 换行/连续空白压成单空格
  if (s.length > maxLen) s = s.slice(0, maxLen)
  return s
}

/**
 * 生成达人邀约话术：用「商品信息」做参考。提示词固定在本函数内，
 * 渲染层只能通过 goodsText / instruction / maxLen 三个受限参数影响它。
 */
export async function generateInviteScript(opts: { goodsText: string; maxLen: number; instruction?: string }): Promise<{ script: string; model: string; sourceChars: number }> {
  const maxLen = Math.min(Math.max(Math.round(opts.maxLen) || 150, 20), 300)
  const goods = String(opts.goodsText || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (!goods) throw new AiError('AI_EMPTY_SOURCE', '没有读到可用于生成话术的商品信息')
  const system = [
    '你是电商招商运营，负责给抖音精选联盟的达人写邀约私信。',
    `请只输出邀约话术正文，不超过 ${maxLen} 个汉字，不要引号、不要换行、不要任何解释或标题。`,
    '话术要求：一句称呼开头；说明店铺与主营品类；给出具体合作理由（可参考商品卖点/价格带/佣金）；明确能给达人的权益；结尾给一个低门槛的行动指引。',
    '不要编造商品信息里没有的数字或承诺。'
  ].join('\n')
  const user = [
    opts.instruction ? `补充要求：${String(opts.instruction).slice(0, 300)}` : '',
    '以下是平台上为该批达人推荐的带货商品信息（可能含标题、价格、佣金等）：',
    goods
  ].filter(Boolean).join('\n')

  const r = await chatComplete({ system, user, maxTokens: Math.min(800, maxLen * 4) })
  const script = cleanScript(r.text, maxLen)
  if (!script) throw new AiError('AI_EMPTY_OUTPUT', '模型输出清洗后为空')
  return { script, model: r.model, sourceChars: goods.length }
}
