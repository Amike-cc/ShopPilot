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
import { getAiImageKey, getAiImageTextKey, getAiKey, hasAiImageKey, hasAiImageTextKey, hasAiKey } from './credential-store'
import { logMain } from './logger'
import { ModelGovernanceError, assertMeteredBudget, recordModelUsage, resolveMeteringTarget } from './model-governance'
import { buildChatRequestBody, buildChatRequestHeaders, buildVisionUserContent, clampMaxOutputTokens, DEFAULT_TEMPERATURE } from './model-request'
// 生图 / 生图文本两条链路各自的默认超时（30 秒对这两条链路太紧，见 constants/ai.ts 注释）
import { DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS, DEFAULT_AI_IMAGE_TIMEOUT_MS } from '@shared/constants/ai'

export {
  DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, DEFAULT_AI_IMAGE_ENDPOINT, DEFAULT_AI_IMAGE_MODEL, DEFAULT_AI_IMAGE_TEXT_ENDPOINT, DEFAULT_AI_IMAGE_TEXT_MODEL,
  DEFAULT_AI_IMAGE_TIMEOUT_MS, DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS,
  AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, normalizeAiEndpoint, normalizeImageEndpoint, modelsUrlFromChat, modelsUrlFromImageEndpoint, imageUrlFromChat,
  imageEditUrlFromGeneration
} from '@shared/constants/ai'
import {
  AI_IMAGE_SETTING_KEYS, AI_IMAGE_TEXT_SETTING_KEYS, DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, DEFAULT_AI_IMAGE_ENDPOINT, DEFAULT_AI_IMAGE_MODEL, DEFAULT_AI_IMAGE_TEXT_ENDPOINT, DEFAULT_AI_IMAGE_TEXT_MODEL,
  AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, normalizeAiEndpoint, normalizeImageEndpoint, modelsUrlFromChat, modelsUrlFromImageEndpoint,
  imageEditUrlFromGeneration
} from '@shared/constants/ai'

export interface AiConfig {
  /** 用户填写的原始地址（可能是"基础地址"，如 https://api.xxx.com/v1） */
  endpoint: string
  /** 规范化后**实际请求**的补全地址（界面据此展示"实际请求地址"） */
  resolvedEndpoint: string
  model: string
  timeoutMs: number
  /** 仅告知"是否已配置"，绝不回传 Key 本身 */
  hasKey: boolean
  /** 生图 API 独立配置；空值表示用户尚未显式配置图片服务。 */
  imageEndpoint: string
  resolvedImageEndpoint: string
  imageModel: string
  imageTimeoutMs: number
  hasImageKey: boolean
  /** AI 生成商品图片页面的商品分析文本 API，完全独立于 Agent 与生图 API。 */
  imageTextEndpoint: string
  resolvedImageTextEndpoint: string
  imageTextModel: string
  imageTextTimeoutMs: number
  hasImageTextKey: boolean
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
  const imageEndpoint = String(readSetting(AI_IMAGE_SETTING_KEYS.endpoint) ?? '').trim() || DEFAULT_AI_IMAGE_ENDPOINT
  const imageModel = String(readSetting(AI_IMAGE_SETTING_KEYS.model) ?? '').trim() || DEFAULT_AI_IMAGE_MODEL
  const rawImageTimeout = Number(readSetting(AI_IMAGE_SETTING_KEYS.timeoutMs) ?? DEFAULT_AI_IMAGE_TIMEOUT_MS)
  const imageTimeoutMs = Number.isFinite(rawImageTimeout)
    ? Math.min(Math.max(Math.round(rawImageTimeout), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS)
    : DEFAULT_AI_IMAGE_TIMEOUT_MS
  const imageTextEndpoint = String(readSetting(AI_IMAGE_TEXT_SETTING_KEYS.endpoint) ?? '').trim() || DEFAULT_AI_IMAGE_TEXT_ENDPOINT
  const imageTextModel = String(readSetting(AI_IMAGE_TEXT_SETTING_KEYS.model) ?? '').trim() || DEFAULT_AI_IMAGE_TEXT_MODEL
  const rawImageTextTimeout = Number(readSetting(AI_IMAGE_TEXT_SETTING_KEYS.timeoutMs) ?? DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS)
  const imageTextTimeoutMs = Number.isFinite(rawImageTextTimeout)
    ? Math.min(Math.max(Math.round(rawImageTextTimeout), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS)
    : DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS
  // 中转站/自建网关常只给"基础地址"：统一规范化后再用（拼接规则见 shared/constants/ai.ts）
  return {
    endpoint,
    resolvedEndpoint: normalizeAiEndpoint(endpoint),
    model,
    timeoutMs,
    hasKey: hasAiKey(),
    imageEndpoint,
    resolvedImageEndpoint: normalizeImageEndpoint(imageEndpoint),
    imageModel,
    imageTimeoutMs,
    hasImageKey: hasAiImageKey(),
    imageTextEndpoint,
    resolvedImageTextEndpoint: normalizeAiEndpoint(imageTextEndpoint),
    imageTextModel,
    imageTextTimeoutMs,
    hasImageTextKey: hasAiImageTextKey()
  }
}

function assertEndpointUsable(endpoint: string): void {
  if (/^https:\/\//i.test(endpoint)) return
  // 仅本机地址允许 http（接本地模型），其余必须 https —— 避免把 Key 明文发到公网
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(endpoint)
  if (isLoopback) return
  throw new AiError('AI_BAD_ENDPOINT', '接口地址须为 https://（仅 127.0.0.1 / localhost 允许 http://）')
}

/**
 * legacy 文本补全（chatComplete）的输出 token 上限。
 *
 * 为什么不是 1200（原值）：推理型模型会把预算先花在 `reasoning_content`（思考）上，
 * 1200 用尽时 `finish_reason=length`、`content` 为空——真机实测（2026-10-03）用户的
 * 「微信小店达人邀约」任务就因此恒定失败在「AI 生成话术」这一步。
 * 放宽到 8192 只影响"调用方主动申请更大预算"的场景，默认值仍是 400。
 */
const LEGACY_CHAT_MAX_OUTPUT_TOKENS = 8192

export interface AiChatResult {
  text: string
  model: string
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  /** 这次文本补全实际用的是哪一套配置：单独的"生图文本 API"还是回退到主文本 API。 */
  source?: 'image-text' | 'main-text'
}

/**
 * 单轮补全。system/user 都由本文件或调用方构造，不接受渲染层传入的任意角色/消息数组。
 *
 * 计量（审计 P1）：这条 legacy 链路原先既不计入 `agent_usage`、也不受日预算约束，
 * 现在与 Agent 链路共用 services/model-governance 的口径：请求前按"本次最大输出"预留校验日预算，
 * 响应后（成功/失败都）写一条用量记录，单价取自主 Agent 绑定的那个 Profile。
 * 未绑定 Profile 时如实跳过计量并记一条 warn —— 不假装已经计过。
 */
export async function chatComplete(opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number; safeErrors?: boolean; images?: Array<{ mimeType: string; b64Json: string }> }): Promise<AiChatResult> {
  const cfg = getAiConfig()
  const key = getAiKey()
  if (!key || !key.trim()) throw new AiError('AI_NOT_CONFIGURED', '未配置大模型 API Key（设置 → AI 配置）')
  assertEndpointUsable(cfg.resolvedEndpoint)

  /**
   * 输出预算上限。原先写死 1200，对**推理型模型**不够用：
   * 实测该网关（api.deepseek.com）上的 `deepseek-flash` / `deepseek-v4-pro` 都是推理型，
   * 会先把思考写进 `reasoning_content`、正文才轮到 `content`；预算用尽时返回
   * `finish_reason=length` + 空 `content`（实测 800 → 思考 1249 字；1200 → 思考 1860 字，均无正文），
   * 于是「AI 生成话术」恒定失败（用户 2026-10-03 09:57 的邀约任务就折在这一步）。
   * 这里只放宽**上限**：默认仍是 400，调用方按需申请（邀约话术那条链路申请更宽并带一次加倍重试）。
   */
  const maxTokens = clampMaxOutputTokens(opts.maxTokens ?? 400, 64, LEGACY_CHAT_MAX_OUTPUT_TOKENS)
  const target = resolveMeteringTarget()
  if (target) {
    // 预算不足时如实拒绝：宁可让用户看到"今日预算已用完"，也不静默消耗
    assertMeteredBudget(target, maxTokens)
  } else {
    logMain('warn', '[ai] 未解析到计量目标（主 Agent 未绑定模型 Profile），本次调用不计入用量与日预算')
  }

  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(cfg.resolvedEndpoint, {
      method: 'POST',
      headers: buildChatRequestHeaders(key),
      body: JSON.stringify(buildChatRequestBody({
        model: cfg.model,
        system: opts.system,
        user: opts.user,
        temperature: DEFAULT_TEMPERATURE,
        maxTokens,
        // 有图时走多模态（content 数组）；没图时保持原来的纯字符串，行为不变
        userContent: opts.images?.length ? buildVisionUserContent(opts.user, opts.images) : undefined,
        stream: false
      })),
      signal: ac.signal
    })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', opts.safeErrors ? `HTTP ${res.status}` : `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new AiError('AI_REQUEST_FAILED', '响应不是合法 JSON')
    }
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) {
      /**
       * 空内容时把"为什么空"带出来（2026-10-03 真机实测驱动）。
       *
       * 原先只报「模型返回了空内容」，看不出是超长截断、内容审核还是**推理型模型把正文写进了
       * `reasoning_content`**（后者实测遇到：同一个 Key，短提示词的「测试连接」能过，而邀约话术
       * 这条中等长度的提示词 content 恒为空）。这里只记录 finish_reason 与各字段**长度**，
       * 不落正文（可能含商品/店铺信息）。
       */
      const choice = data?.choices?.[0] || {}
      const message = choice?.message || {}
      const reasoningLen = String(message.reasoning_content ?? '').length
      const refusal = String(message.refusal ?? '').length
      const detail = [
        `finish_reason=${String(choice?.finish_reason ?? '未知')}`,
        `message 字段=[${Object.keys(message).join(',') || '无'}]`,
        reasoningLen ? `reasoning_content ${reasoningLen} 字` : '',
        refusal ? `refusal ${refusal} 字` : ''
      ].filter(Boolean).join('，')
      logMain('warn', `[ai] 空内容 model=${String(data?.model || cfg.model)} ${detail}`)
      throw new AiError('AI_EMPTY_OUTPUT', `模型返回了空内容（${detail}）`)
    }
    if (target) recordModelUsage({ agentId: target.agentId, profileId: target.profileId, parsed: data, status: 'succeeded' })
    return {
      text,
      model: String(data?.model || cfg.model),
      elapsedMs: Date.now() - t0,
      inputTokens: usageTokensFrom(data, 'prompt_tokens'),
      outputTokens: usageTokensFrom(data, 'completion_tokens')
    }
  } catch (e: any) {
    if (target && !(e instanceof AiError && e.code === 'AI_NOT_CONFIGURED')) {
      // 失败也留痕（§7.3）：网络/超时/HTTP 错误都要能解释"这次调用没白试"
      recordModelUsage({ agentId: target.agentId, profileId: target.profileId, status: 'failed', errorCode: e?.code || 'AI_REQUEST_FAILED' })
    }
    if (e instanceof AiError) throw e
    if (e instanceof ModelGovernanceError) throw new AiError(e.code, e.message)
    if (e?.name === 'AbortError') throw new AiError('AI_TIMEOUT', `请求超过 ${timeoutMs}ms 未返回`)
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally {
    clearTimeout(timer)
  }
}

/** 服务商 usage 的两种命名都认（与 Main 其它链路同一口径）。 */
function usageTokensFrom(payload: unknown, key: 'prompt_tokens' | 'completion_tokens'): number {
  const usage = (payload as { usage?: Record<string, unknown> } | null | undefined)?.usage
  const value = Number(usage?.[key] ?? usage?.[key === 'prompt_tokens' ? 'input_tokens' : 'output_tokens'])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
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
  const url = modelsUrlFromChat(endpoint)
  if (!url) throw new AiError('AI_BAD_ENDPOINT', '接口地址无法推导出 /models 地址（请填基础地址或完整的 /chat/completions 地址）')
  return url
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
  assertEndpointUsable(cfg.resolvedEndpoint)
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
    const models = [...new Set(arr.map((x: any) => String(x?.id ?? x?.name ?? x ?? '').trim()).filter(Boolean))].sort() as string[]
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

/**
 * 商品图片工作台专用文本补全。
 *
 * **生图文本 API 是可选的**（2026-10-02 重构）：单独配置了 `ai.imageText.*` + `ai_cred.imageTextKey`
 * 就用那一套；没配置时**回退到设置里那一套文本 API**（与 Agent 同源）。为什么改：
 * 用户明明已经配好了文本模型，却因为"没有单独再配一套"导致「AI 整理卖点」整块不可用、
 * 页面还顶着一行"需要配置生图文本 API"的警告——功能看起来是坏的。
 *
 * 回退时走 `chatComplete` 而不是自己拼请求：这样用量与日预算仍然被计量，
 * 不会出现"从图片工作台绕开预算"的隐藏消耗（审计 P1 的口径）。返回值里带 `source`，
 * 界面据此如实显示这次分析用的是哪一套配置。
 */
export async function chatCompleteForImageText(opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number; images?: Array<{ mimeType: string; b64Json: string }> }): Promise<AiChatResult> {
  const cfg = getAiConfig()
  const key = getAiImageTextKey()
  if (!key || !key.trim() || !cfg.imageTextEndpoint || !cfg.imageTextModel) {
    try {
      const result = await chatComplete({ system: opts.system, user: opts.user, maxTokens: opts.maxTokens, images: opts.images })
      return { ...result, source: 'main-text' }
    } catch (e: any) {
      if (e instanceof AiError && e.code === 'AI_NOT_CONFIGURED') {
        throw new AiError('AI_IMAGE_TEXT_NOT_CONFIGURED', '既没有单独的"生图文本 API"，也没有可用的文本 API；请在「设置中心 → AI 配置」里配置其中一套')
      }
      throw e
    }
  }
  const endpoint = cfg.resolvedImageTextEndpoint || normalizeAiEndpoint(cfg.imageTextEndpoint)
  if (!endpoint) throw new AiError('AI_BAD_ENDPOINT', '生图文本接口地址无效，请填写基础地址或完整的 /chat/completions 地址')
  assertEndpointUsable(endpoint)

  const maxTokens = clampMaxOutputTokens(opts.maxTokens ?? 800, 64, 1600)
  const timeoutMs = Math.min(Math.max(Math.round(Number(opts.timeoutMs ?? cfg.imageTextTimeoutMs)), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: buildChatRequestHeaders(key),
      body: JSON.stringify(buildChatRequestBody({
        model: cfg.imageTextModel,
        system: opts.system,
        user: opts.user,
        temperature: DEFAULT_TEMPERATURE,
        maxTokens,
        userContent: opts.images?.length ? buildVisionUserContent(opts.user, opts.images) : undefined,
        stream: false
      })),
      signal: ac.signal
    })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try { data = JSON.parse(bodyText) } catch { throw new AiError('AI_REQUEST_FAILED', '生图文本接口响应不是合法 JSON') }
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new AiError('AI_EMPTY_OUTPUT', '生图文本模型返回了空内容')
    return {
      text,
      model: String(data?.model || cfg.imageTextModel),
      elapsedMs: Date.now() - t0,
      inputTokens: usageTokensFrom(data, 'prompt_tokens'),
      outputTokens: usageTokensFrom(data, 'completion_tokens'),
      source: 'image-text' as const
    }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') {
      // 如实说清"这不是配置错，是模型慢"并给出可执行的下一步：
      // 用户配的是对的，但 30 秒默认值会让一次 25~40 秒的分析被判成失败。
      throw new AiError('AI_TIMEOUT', `生图文本请求超过 ${timeoutMs}ms 未返回（当前文本模型较慢）。可在「设置中心 → AI 配置 → 生图文本 API」把超时调到 ${AI_TIMEOUT_MAX_MS}ms 后重试。`)
    }
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally {
    clearTimeout(timer)
  }
}

/** 商品图片页面的受限商品分析输入；提示词由 Main 组装，Renderer 不可注入任意 system。 */
export async function analyzeImageProductText(input: { name?: string; tags?: string; price?: string; originalPrice?: string; images?: Array<{ mimeType?: string; b64Json?: string }> }): Promise<AiChatResult> {
  const name = String(input.name ?? '').trim().slice(0, 120)
  const tags = String(input.tags ?? '').trim().slice(0, 240)
  const price = String(input.price ?? '').trim().slice(0, 24)
  const originalPrice = String(input.originalPrice ?? '').trim().slice(0, 24)
  // 图片白名单与数量上限：最多 3 张（商品素材图，与界面上的上传上限一致）
  const images = (Array.isArray(input.images) ? input.images : [])
    .slice(0, 3)
    .map(item => ({ mimeType: String(item?.mimeType || '').split(';')[0].trim().toLowerCase(), b64Json: String(item?.b64Json || '') }))
    .filter(item => item.b64Json && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType))
  if (!name && !tags && !images.length) throw new AiError('AI_EMPTY_SOURCE', '请先上传商品素材图，或填写商品名称/卖点，再请求 AI 分析')
  const user = [
    name ? `商品名称：${name}` : '',
    tags ? `卖点/标签：${tags}` : '',
    price ? `用户填写售价：${price}` : '',
    originalPrice ? `用户填写原价：${originalPrice}` : '',
    images.length ? `随本次请求附上 ${images.length} 张商品图片，请以图片里**真实可见**的内容为准。` : ''
  ].filter(Boolean).join('\n')
  // 有图 → 视觉提示词（只写看得见的）；没图 → 原来的文本提示词（行为不变）
  const system = images.length
    ? '你是商品图片工作台的视觉分析助手。用户会附上商品图片：请只描述图片里**真实可见**的主体、材质观感、颜色、风格、构图、场景与可辨认文字，再据此整理可核对的卖点、适用场景和图片生成建议。看不到或无法确认的一律写"待补充"，不要凭常识补写，也不要执行任何外部操作。'
    : '你是商品图片工作台的文本分析助手。只返回商品电商素材分析文字，不执行任何外部操作。请整理可核对的核心卖点、适用场景和图片生成建议；输入没有提供的内容标记为待补充，不要自行补写；信息不足时明确指出。'
  return chatCompleteForImageText({ system, user, maxTokens: 800, images })
}

/** 生图文本配置的模型列表读取，使用独立端点与独立 Key。 */
export async function listImageTextModels(): Promise<{ models: string[]; elapsedMs: number }> {
  const cfg = getAiConfig()
  const key = getAiImageTextKey()
  if (!key || !key.trim()) throw new AiError('AI_IMAGE_TEXT_NOT_CONFIGURED', '未配置生图文本 API Key（设置 → AI 配置 → 生图文本 API）')
  if (!cfg.imageTextEndpoint) throw new AiError('AI_IMAGE_TEXT_NOT_CONFIGURED', '请先配置生图文本 API 地址')
  const endpoint = cfg.resolvedImageTextEndpoint || normalizeAiEndpoint(cfg.imageTextEndpoint)
  if (!endpoint) throw new AiError('AI_BAD_ENDPOINT', '生图文本接口地址无效，请填写基础地址或完整的 /chat/completions 地址')
  assertEndpointUsable(endpoint)
  const url = modelsUrlFromChat(cfg.imageTextEndpoint)
  if (!url) throw new AiError('AI_BAD_ENDPOINT', '生图文本接口地址无法推导出 /models 地址')

  const ac = new AbortController()
  const timeoutMs = Math.min(cfg.imageTextTimeoutMs, 20000)
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', headers: buildChatRequestHeaders(key), signal: ac.signal })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try { data = JSON.parse(bodyText) } catch { throw new AiError('AI_REQUEST_FAILED', '生图文本模型接口响应不是合法 JSON') }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null
    if (!arr) throw new AiError('AI_REQUEST_FAILED', '生图文本模型接口没有返回模型列表（期望 { data: [{ id }] }）')
    const models = [...new Set(arr.map((x: any) => String(x?.id ?? x?.name ?? x ?? '').trim()).filter(Boolean))].sort() as string[]
    if (!models.length) throw new AiError('AI_EMPTY_OUTPUT', '生图文本接口没有返回任何可用模型')
    logMain('info', `[ai:image-text] 获取可用模型成功 count=${models.length} ${Date.now() - t0}ms`)
    return { models, elapsedMs: Date.now() - t0 }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI_TIMEOUT', `生图文本模型请求超过 ${timeoutMs}ms 未返回`)
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally {
    clearTimeout(timer)
  }
}

/** 生图文本配置的连通性检查：只发最小文本请求，不调用图片生成。 */
export async function testImageTextConnection(): Promise<{ ok: true; model: string; elapsedMs: number } | { ok: false; code: string; message: string }> {
  try {
    const r = await chatCompleteForImageText({
      system: '你是连通性测试助手。',
      user: '只回复两个字：可用',
      maxTokens: 16,
      timeoutMs: Math.min(getAiConfig().imageTextTimeoutMs, 20000)
    })
    logMain('info', `[ai:image-text] 测试连接成功 model=${r.model} ${r.elapsedMs}ms`)
    return { ok: true, model: r.model, elapsedMs: r.elapsedMs }
  } catch (e: any) {
    const code = e instanceof AiError ? e.code : 'AI_REQUEST_FAILED'
    const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
    logMain('warn', `[ai:image-text] 测试连接失败 ${code}: ${message}`)
    return { ok: false, code, message }
  }
}

/** 图片 API 的模型列表读取，使用独立端点与独立 Key。 */
export async function listImageModels(): Promise<{ models: string[]; elapsedMs: number }> {
  const cfg = getAiConfig()
  const key = getAiImageKey()
  if (!key || !key.trim()) throw new AiError('AI_IMAGE_NOT_CONFIGURED', '未配置生图 API Key（设置 → AI 配置 → 生图 API）')
  if (!cfg.imageEndpoint) throw new AiError('AI_IMAGE_NOT_CONFIGURED', '请先配置生图 API 地址')
  const endpoint = cfg.resolvedImageEndpoint || normalizeImageEndpoint(cfg.imageEndpoint)
  if (!endpoint) throw new AiError('AI_BAD_ENDPOINT', '生图接口地址无效，请填写基础地址或 /images/generations 地址')
  assertEndpointUsable(endpoint)
  const url = modelsUrlFromImageEndpoint(cfg.imageEndpoint)
  if (!url) throw new AiError('AI_BAD_ENDPOINT', '生图接口地址无法推导出 /models 地址')

  const ac = new AbortController()
  const timeoutMs = Math.min(cfg.imageTimeoutMs, 20000)
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: ac.signal })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try { data = JSON.parse(bodyText) } catch { throw new AiError('AI_REQUEST_FAILED', '生图模型接口响应不是合法 JSON') }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null
    if (!arr) throw new AiError('AI_REQUEST_FAILED', '生图模型接口没有返回模型列表（期望 { data: [{ id }] }）')
    const models = [...new Set(arr.map((x: any) => String(x?.id ?? x?.name ?? x ?? '').trim()).filter(Boolean))].sort() as string[]
    if (!models.length) throw new AiError('AI_EMPTY_OUTPUT', '生图接口没有返回任何可用模型')
    logMain('info', `[ai:image] 获取可用模型成功 count=${models.length} ${Date.now() - t0}ms`)
    return { models, elapsedMs: Date.now() - t0 }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI_TIMEOUT', `生图模型请求超过 ${timeoutMs}ms 未返回`)
    throw new AiError('AI_REQUEST_FAILED', String(e?.message || e).slice(0, 180))
  } finally { clearTimeout(timer) }
}

/** 生图设置的无费用连通性检查：只读 GET /models，不调用付费生成端点。 */
export async function testImageConnection(): Promise<{ ok: true; model: string; elapsedMs: number } | { ok: false; code: string; message: string }> {
  try {
    const cfg = getAiConfig()
    const result = await listImageModels()
    const model = cfg.imageModel || result.models[0] || '未返回模型名'
    logMain('info', `[ai:image] 测试连接成功 model=${model} ${result.elapsedMs}ms`)
    return { ok: true, model, elapsedMs: result.elapsedMs }
  } catch (e: any) {
    const code = e instanceof AiError ? e.code : 'AI_REQUEST_FAILED'
    const message = String(e?.message || e).replace(/^[A-Z_]+:\s*/, '')
    logMain('warn', `[ai:image] 测试连接失败 ${code}: ${message}`)
    return { ok: false, code, message }
  }
}

export interface AiImageResult {
  images: Array<{ b64Json: string; mimeType: string }>
  model: string
  elapsedMs: number
}

export interface AiImageSource {
  /** 仅用于 multipart 的文件名，主进程会再次清洗。 */
  name: string
  mimeType: string
  /** 不含 data: 前缀的 base64 内容。 */
  b64Json: string
}

/**
 * 供应商有时只返回短期 URL，而渲染层 CSP 不允许直接加载外部图片。
 * 在主进程把 URL 读回为受限大小的 base64，既保持 Main-only 出网，也让结果可以安全预览。
 */
async function materializeImageUrl(rawUrl: string, timeoutMs: number): Promise<{ b64Json: string; mimeType: string }> {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { throw new AiError('AI_IMAGE_FETCH_FAILED', '图片结果 URL 无效') }
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopback) throw new AiError('AI_IMAGE_FETCH_FAILED', '图片结果 URL 不是受支持的 HTTPS 地址')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(parsed, { method: 'GET', signal: ac.signal })
    if (!res.ok) throw new AiError('AI_IMAGE_FETCH_FAILED', `读取图片结果失败：HTTP ${res.status}`)
    const declaredLength = Number(res.headers.get('content-length') || 0)
    if (declaredLength > 12 * 1024 * 1024) throw new AiError('AI_IMAGE_FETCH_FAILED', '图片结果超过 12MB，已停止预览')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new AiError('AI_IMAGE_FETCH_FAILED', '图片结果为空或超过 12MB')
    const mimeType = String(res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase()
    if (!mimeType.startsWith('image/')) throw new AiError('AI_IMAGE_FETCH_FAILED', '图片结果响应不是图片类型')
    return { b64Json: buffer.toString('base64'), mimeType }
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI_IMAGE_FETCH_FAILED', `读取图片结果超过 ${timeoutMs}ms`)
    throw new AiError('AI_IMAGE_FETCH_FAILED', String(e?.message || e).slice(0, 180))
  } finally { clearTimeout(timer) }
}

/**
 * 调用 OpenAI 兼容的图片生成端点。
 * 图片 API 没有在渲染层暴露，Key 仍只存在主进程；此方法也不自动重试，
 * 由界面在调用前完成费用确认。存在上传图时使用明确推导出的 `/images/edits`
 * multipart 端点；供应商不支持该端点时返回真实错误，不回退成伪造结果。
 */
export async function generateImage(opts: { prompt: string; size?: string; n?: number; sourceImages?: AiImageSource[] }): Promise<AiImageResult> {
  const cfg = getAiConfig()
  const key = getAiImageKey()
  if (!key || !key.trim()) throw new AiError('AI_IMAGE_NOT_CONFIGURED', '未配置生图 API Key（设置 → AI 配置 → 生图 API）')
  if (!cfg.imageModel) throw new AiError('AI_IMAGE_NOT_CONFIGURED', '未配置生图模型（设置 → AI 配置 → 生图 API）')
  const generationEndpoint = cfg.resolvedImageEndpoint || normalizeImageEndpoint(cfg.imageEndpoint)
  if (!generationEndpoint) throw new AiError('AI_BAD_ENDPOINT', '生图接口地址无效，请填基础地址或完整的 /images/generations 地址')
  assertEndpointUsable(generationEndpoint)
  const prompt = String(opts.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  if (!prompt) throw new AiError('AI_EMPTY_SOURCE', '请输入图片生成描述')
  const size = ['1024x1024', '1536x1024', '1024x1536'].includes(String(opts.size)) ? String(opts.size) : '1024x1024'
  const n = Math.min(Math.max(Math.round(Number(opts.n) || 1), 1), 4)
  // 生图模型唯一以设置中心的 AI_IMAGE_SETTING_KEYS.model 为准，调用参数不提供模型覆盖口。
  const model = cfg.imageModel
  const sourceImages = Array.isArray(opts.sourceImages) ? opts.sourceImages.slice(0, 10) : []
  const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp'])
  const normalizedSources = sourceImages.map((source, index) => {
    const mimeType = String(source?.mimeType || '').split(';')[0].trim().toLowerCase()
    const b64Json = String(source?.b64Json || '').trim()
    if (!allowedMime.has(mimeType)) throw new AiError('AI_BAD_INPUT', `第 ${index + 1} 个参考图片类型不受支持`)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64Json) || b64Json.length < 16) throw new AiError('AI_BAD_INPUT', `第 ${index + 1} 个参考图片内容无效`)
    const bytes = Buffer.from(b64Json, 'base64')
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new AiError('AI_BAD_INPUT', `第 ${index + 1} 个参考图片超过 8MB`)
    const name = String(source?.name || `reference-${index + 1}`).replace(/[^\w.\-()\u4e00-\u9fff ]/g, '_').slice(0, 120) || `reference-${index + 1}`
    return { name, mimeType, bytes }
  })
  const endpoint = normalizedSources.length ? imageEditUrlFromGeneration(generationEndpoint) : generationEndpoint
  if (!endpoint) throw new AiError('AI_BAD_ENDPOINT', '当前图片地址不支持参考图编辑（需要明确的 /images/generations 路径）')
  const timeoutMs = cfg.imageTimeoutMs
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    let body: BodyInit
    let headers: HeadersInit
    if (normalizedSources.length) {
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', prompt)
      form.set('size', size)
      form.set('n', String(n))
      form.set('response_format', 'b64_json')
      for (const source of normalizedSources) {
        form.append('image', new Blob([source.bytes], { type: source.mimeType }), source.name)
      }
      body = form
      headers = { Authorization: `Bearer ${key}` }
    } else {
      body = JSON.stringify({ model, prompt, size, n, response_format: 'b64_json' })
      headers = buildChatRequestHeaders(key)
    }
    const res = await fetch(endpoint, { method: 'POST', headers, body, signal: ac.signal })
    const bodyText = await res.text()
    if (!res.ok) throw new AiError('AI_REQUEST_FAILED', `HTTP ${res.status} ${bodyText.slice(0, 180)}`)
    let data: any = null
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new AiError('AI_REQUEST_FAILED', '图片接口响应不是合法 JSON')
    }
    const rows = Array.isArray(data?.data) ? data.data : []
    const images: AiImageResult['images'] = []
    for (const row of rows) {
      const url = typeof row?.url === 'string' ? row.url.trim() : ''
      const b64Json = typeof row?.b64_json === 'string' ? row.b64_json.trim() : ''
      if (b64Json) images.push({ b64Json, mimeType: String(row?.mime_type || row?.mimeType || 'image/png').split(';')[0].trim() || 'image/png' })
      else if (url) images.push(await materializeImageUrl(url, timeoutMs))
    }
    if (!images.length) throw new AiError('AI_EMPTY_OUTPUT', '图片接口没有返回可预览的图片')
    return { images, model: String(data?.model || model), elapsedMs: Date.now() - t0 }
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

  /**
   * 输出预算与超时：**给推理型模型留出"思考 + 正文"的余量**。
   *
   * 实测（2026-10-03 真机，用户店铺的网关配置）：
   *   · `maxLen * 4`（200 字 → 800 token）：思考 1249 字，正文空，finish_reason=length；
   *   · 1200 token（当时的硬上限）：思考 1860 字，正文仍空；
   *   · 该模型是推理型，预算越大思考越长 —— 所以预算要给足，并且**失败时再翻倍重试一次**，
   *     而不是一次用尽就判死刑（旧实现在这里恒定失败，邀约任务第 1 轮就停）。
   * 超时同理：思考阶段本身就慢，30s 的默认超时对这条链路太紧，这里放宽到至少 120s
   * （步骤侧 aiGenerate 的 timeoutMs 是 120s，与它对齐）。
   */
  const baseTokens = Math.min(6000, Math.max(3000, maxLen * 16))
  const callOpts = { system, user, timeoutMs: Math.max(getAiConfig().timeoutMs, 120_000) }
  let r: AiChatResult
  try {
    r = await chatComplete({ ...callOpts, maxTokens: baseTokens })
  } catch (e) {
    if (e instanceof AiError && e.code === 'AI_EMPTY_OUTPUT') {
      // 预算被思考吃光（finish_reason=length + content 空）：加倍预算再试一次。
      // 仍然拿不到正文时把原因如实抛给上层（错误信息里带 finish_reason 与思考长度）。
      logMain('warn', `[ai] 邀约话术首次空输出（预算 ${baseTokens}），加倍预算重试一次`)
      r = await chatComplete({ ...callOpts, maxTokens: Math.min(LEGACY_CHAT_MAX_OUTPUT_TOKENS, baseTokens * 2) })
    } else {
      throw e
    }
  }
  const script = cleanScript(r.text, maxLen)
  if (!script) throw new AiError('AI_EMPTY_OUTPUT', '模型输出清洗后为空')
  return { script, model: r.model, sourceChars: goods.length }
}
