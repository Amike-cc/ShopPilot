/**
 * Context accounting shared by Main and the renderer-facing planning code.
 *
 * Providers do not expose one consistent context-window field.  Profiles may
 * therefore leave the override empty and the runtime infers a conservative
 * window from the model name.  The same estimator is used when packing
 * history, memory and model output so a large task does not fail because one
 * fixed character limit was chosen for every model.
 *
 * Budgets are token-denominated.  Character allowances are derived with
 * `estimateAgentChars` (the estimator's worst case, all-CJK text, is 1 token ≈
 * 1.35 characters) and token-bounded text is cut with `truncateTextToTokens`,
 * so a slice that respects a char budget cannot exceed the matching token
 * budget.  `compactAgentPrompt` remains the hard final guard for payloads
 * that mix many budgets in one request.
 */

export const DEFAULT_MODEL_CONTEXT_TOKENS = 32768
export const MIN_MODEL_CONTEXT_TOKENS = 4096
export const MAX_MODEL_CONTEXT_TOKENS = 2_000_000

/** 推导来源：手动覆盖 / 模型名提示 / 兜底默认。契约与 UI 都引用这一份，避免枚举漂移。 */
export const MODEL_CONTEXT_SOURCES = ['override', 'model-name', 'provider-default'] as const

export type ModelContextSource = (typeof MODEL_CONTEXT_SOURCES)[number]

export type AgentContextBudget = {
  contextWindowTokens: number
  source: ModelContextSource
  maxInputTokens: number
  outputTokens: number
  maxInputChars: number
  historyChars: number
  memoryChars: number
  jobResultsChars: number
}

export type AgentConversationTurn = { role: 'user' | 'assistant'; text: string }

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function parseWindowHint(value: string): number | null {
  const text = value.toLowerCase().replace(/[._]/g, '-')
  // Explicit names such as 32k, 128k and 1048576 are more trustworthy than a
  // provider guess.  Keep the upper bound conservative when a vendor uses a
  // marketing name that is not a real context limit.
  const tokenMatch = text.match(/(?:context|ctx|window)[- ]?(\d{1,7})(k|m)?\b/)
  if (tokenMatch) {
    const amount = Number(tokenMatch[1])
    const multiplier = tokenMatch[2] === 'm' ? 1_000_000 : tokenMatch[2] === 'k' ? 1_000 : 1
    if (Number.isFinite(amount)) return clampInt(amount * multiplier, MIN_MODEL_CONTEXT_TOKENS, MAX_MODEL_CONTEXT_TOKENS)
  }
  const shortMatch = text.match(/\b(4|8|16|32|64|128|200|256|400|512)(k|m)\b/)
  if (shortMatch) {
    const amount = Number(shortMatch[1]) * (shortMatch[2] === 'm' ? 1_000_000 : 1_000)
    return clampInt(amount, MIN_MODEL_CONTEXT_TOKENS, MAX_MODEL_CONTEXT_TOKENS)
  }
  if (/1048576|1m|million/.test(text)) return 1_000_000
  return null
}

/**
 * Well-known model windows used before the generic family guess.  Values are
 * conservative lower bounds of the public API windows (a stale entry can only
 * under-use a window, never request more than the API accepts) and an
 * explicit Profile override or a `128k`/`1m` style name hint always wins.
 */
const MODEL_WINDOW_TABLE: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /gpt-4-1(?:-|$|\s)/, tokens: 1_000_000 },      // GPT-4.1 family (incl. mini/nano)
  { pattern: /o1-mini/, tokens: 128_000 },                  // o1-mini stays at 128k
  { pattern: /(?:^|[^a-z0-9])o[134](?:-|$|\s)/, tokens: 200_000 }, // o1 / o3 / o4 family
  { pattern: /claude-(?:3|4)/, tokens: 200_000 },
  { pattern: /gemini-(?:1-5|2)/, tokens: 1_000_000 },
  { pattern: /grok-[2-9]/, tokens: 131_072 },
  { pattern: /glm-4/, tokens: 128_000 }
]

/** Return a conservative effective context window for a configured profile. */
export function resolveModelContextWindow(provider: string, model: string, override?: number | null): { tokens: number; source: ModelContextSource } {
  const explicit = Number(override)
  if (Number.isFinite(explicit) && explicit >= MIN_MODEL_CONTEXT_TOKENS) {
    return { tokens: clampInt(explicit, MIN_MODEL_CONTEXT_TOKENS, MAX_MODEL_CONTEXT_TOKENS), source: 'override' }
  }
  const hinted = parseWindowHint(`${provider} ${model}`)
  if (hinted) return { tokens: hinted, source: 'model-name' }

  const normalized = `${provider} ${model}`.toLowerCase()
  // Dots/underscores in model ids ("gpt-4.1", "claude-3.5") are normalized so
  // one table entry covers every separator style a provider might use.
  const tableId = normalized.replace(/[._]/g, '-')
  const known = MODEL_WINDOW_TABLE.find(entry => entry.pattern.test(tableId))
  if (known) return { tokens: known.tokens, source: 'model-name' }

  // These families commonly support at least 128k, but the exact deployment
  // can still be smaller; an explicit Profile override always wins.
  if (/(gpt-[4-9](?:\.1|o)?|o1|o3|claude-3|claude-4|gemini-1\.[5-9]|gemini-2|deepseek|qwen(?:2\.?5|3)|llama-3\.[1-9]|kimi|moonshot)/.test(normalized)) {
    return { tokens: 128000, source: 'model-name' }
  }
  if (/(32k|32768)/.test(normalized)) return { tokens: 32768, source: 'model-name' }
  if (/(16k|16384)/.test(normalized)) return { tokens: 16384, source: 'model-name' }
  return { tokens: DEFAULT_MODEL_CONTEXT_TOKENS, source: 'provider-default' }
}

/**
 * Code-point test for the scripts the estimator treats as "dense" (one token
 * per ~1.35 characters): Han incl. radicals/compatibility/astral extensions,
 * Hiragana and Katakana.  Plain range checks replace a per-character regex so
 * multi-megabyte payloads can be measured inside the main process without
 * measurable jank.
 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2eff) || // CJK Radicals Supplement
    (code >= 0x2f00 && code <= 0x2fdf) || // Kangxi Radicals
    (code >= 0x2ff0 && code <= 0x2fff) || // Ideographic Description Characters
    code === 0x3005 || code === 0x3007 ||
    (code >= 0x3021 && code <= 0x3029) ||
    (code >= 0x3038 && code <= 0x303b) ||
    (code >= 0x3041 && code <= 0x3096) || // Hiragana
    (code >= 0x309d && code <= 0x309f) ||
    (code >= 0x30a1 && code <= 0x30fa) || // Katakana
    (code >= 0x30fd && code <= 0x30ff) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x20000 && code <= 0x323af)  // CJK Extensions B-H
  )
}

/** A cheap, deliberately conservative token estimate for mixed Chinese/JSON. */
export function estimateAgentTokens(text: string): number {
  const value = String(text || '')
  let cjk = 0
  let other = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x2e80) { other += 1; continue }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        const point = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        if (isCjkCodePoint(point)) cjk += 1
        else other += 1
        index += 1
        continue
      }
    }
    if (isCjkCodePoint(code)) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.ceil(cjk / 1.35 + other / 3.6))
}

/**
 * Largest character count a token budget can hold.  The estimator spends at
 * most 1 token per 1.35 characters (all-CJK content), so any slice whose
 * length stays within this bound also stays within `tokens`.  Using the worst
 * case keeps every char-denominated sub-budget safe for any content mix; the
 * final `compactAgentPrompt` pass still verifies the real token count.
 */
export function estimateAgentChars(tokens: number): number {
  return clampInt(Math.floor(tokens * 1.35), 1, 300000)
}

/**
 * 一次智能体回合内的真实上下文用量（来自服务商返回的 usage，不是估算）。
 *
 * `peakInputTokens` 是单次请求里最大的一次输入：这才是“窗口被占了多少”的真实水位，
 * 因为一个回合可能有多轮模型调用，累加值反映的是成本而不是水位。
 */
export type AgentContextUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  peakInputTokens: number
  contextWindowTokens: number
  maxInputTokens: number
  /** 服务商未返回 usage 时为 false：界面要显示“未报告”，不能显示成 0。 */
  usageReported: boolean
  /**
   * 系统提示词因上下文窗口不足被裁剪时，累计丢掉的字符数（0/缺省 = 未裁剪）。
   * 为什么要上报：裁剪会改变模型看到的规则，属"如实告知"的一部分，不能悄悄发生。
   */
  systemPromptDroppedChars?: number
}

function usageTokens(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0
}

export function emptyAgentContextUsage(contextWindowTokens = 0, maxInputTokens = 0): AgentContextUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    peakInputTokens: 0,
    contextWindowTokens: Math.max(0, Math.floor(Number(contextWindowTokens) || 0)),
    maxInputTokens: Math.max(0, Math.floor(Number(maxInputTokens) || 0)),
    usageReported: false,
    systemPromptDroppedChars: 0
  }
}

/** 从一次模型响应里读出真实用量；兼容 prompt_tokens 与 input_tokens 两种命名。 */
export function readAgentContextUsage(payload: unknown, contextWindowTokens: number, maxInputTokens: number): AgentContextUsage {
  const usage = (payload as { usage?: Record<string, unknown> } | null | undefined)?.usage
  const input = usageTokens(usage?.prompt_tokens ?? usage?.input_tokens)
  const output = usageTokens(usage?.completion_tokens ?? usage?.output_tokens)
  const reported = !!usage && ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens']
    .some(key => (usage as Record<string, unknown>)[key] != null)
  return {
    calls: 1,
    inputTokens: input,
    outputTokens: output,
    peakInputTokens: input,
    contextWindowTokens: Math.max(0, Math.floor(Number(contextWindowTokens) || 0)),
    maxInputTokens: Math.max(0, Math.floor(Number(maxInputTokens) || 0)),
    usageReported: reported
  }
}

export function mergeAgentContextUsage(base: AgentContextUsage, next: AgentContextUsage): AgentContextUsage {
  return {
    calls: base.calls + next.calls,
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    peakInputTokens: Math.max(base.peakInputTokens, next.peakInputTokens),
    contextWindowTokens: next.contextWindowTokens || base.contextWindowTokens,
    maxInputTokens: next.maxInputTokens || base.maxInputTokens,
    usageReported: base.usageReported || next.usageReported,
    // 多轮累计：整个回合里因为裁剪一共丢了多少字
    systemPromptDroppedChars: Number(base.systemPromptDroppedChars || 0) + Number(next.systemPromptDroppedChars || 0)
  }
}

/** 气泡/面板共用的一行水位描述，避免两侧各写一套换算。 */
export function describeAgentContextUsage(usage: AgentContextUsage): string {
  const calls = usage.calls > 0 ? `${usage.calls} 次调用 · ` : ''
  const trimmed = Number(usage.systemPromptDroppedChars || 0) > 0 ? ` · 系统提示词已按窗口裁剪 ${usage.systemPromptDroppedChars} 字` : ''
  if (!usage.usageReported) return `${calls}上下文用量未报告${trimmed}`
  if (!usage.contextWindowTokens) return `${calls}上下文 ${formatAgentTokens(usage.peakInputTokens)}${trimmed}`
  const percent = usage.maxInputTokens > 0 ? Math.round((usage.peakInputTokens / usage.maxInputTokens) * 100) : 0
  return `${calls}上下文 ${formatAgentTokens(usage.peakInputTokens)} / ${formatAgentTokens(usage.contextWindowTokens)}（占输入预算 ${percent}%）${trimmed}`
}

/**
 * 小窗口下的系统提示词降级（审计 P1）。
 *
 * 原行为：`requestChatCompletion` / `executeModelJob` 只压缩**用户**载荷，系统提示词一个字不裁；
 * 一旦系统提示词本身把输入预算吃光（4k 窗口下 maxInputTokens 约 1872，可用给系统提示词的不到 ~1744 token），
 * 直接抛 `AGENT_CONTEXT_TOO_LARGE` —— 用户看到的是"上下文过大"，却没有任何可操作线索。
 *
 * 现在的口径：**先降级、并如实上报裁掉了多少字**，把抛错留给真正的不可恢复情形（连一段都放不下）。
 * 裁剪顺序：从最后一段往前丢（治理条款写在最前面 → 优先保留），每丢一段加一处显式标记，
 * 而不是无声地截断——模型与用户都要能看出"这里被裁过"。
 */
export function compactSystemPrompt(system: string, budgetTokens: number): { text: string; droppedChars: number; truncated: boolean } {
  const raw = String(system || '')
  const budget = clampInt(budgetTokens, 64, 1_500_000)
  if (!raw) return { text: '', droppedChars: 0, truncated: false }
  if (estimateAgentTokens(raw) <= budget) return { text: raw, droppedChars: 0, truncated: false }

  // 段落 = 空行分隔；单段内部再按换行拆一层，避免"整篇没有空行"时一段都丢不掉
  const paragraphs = raw.split(/\n{2,}/).flatMap(block => (estimateAgentTokens(block) > budget ? block.split('\n') : [block]))
  const marker = (dropped: number): string => `\n〔系统提示词过长：已按当前模型窗口裁剪掉 ${dropped} 字未展示内容〕`
  // 标记本身也占 token，先留出余量，避免"裁完还是超"
  const markerReserve = estimateAgentTokens(marker(raw.length)) + 8

  const kept: string[] = []
  let droppedChars = 0
  for (const paragraph of paragraphs) {
    const candidate = [...kept, paragraph].join('\n\n')
    const withMarker = candidate + marker(raw.length)
    if (!kept.length || estimateAgentTokens(withMarker) <= budget - markerReserve) {
      kept.push(paragraph)
    } else {
      droppedChars += paragraph.length + 2
    }
  }

  let text = kept.join('\n\n')
  // 连第一段都放不下：硬截断（truncateTextToTokens 自带省略号），并保证不超预算
  if (estimateAgentTokens(text + marker(droppedChars)) > budget) {
    const hardBudget = Math.max(32, budget - markerReserve)
    const truncatedText = truncateTextToTokens(text || raw, hardBudget)
    droppedChars = Math.max(droppedChars, raw.length - truncatedText.length)
    text = truncatedText
  }
  const finalText = droppedChars > 0 ? `${text}${marker(droppedChars)}` : text
  return { text: finalText, droppedChars, truncated: droppedChars > 0 }
}

/**
 * 面板显示“实际按多大窗口在跑”。只写“自动推导”无法自查——模型行为异常时
 * （例如你以为是 128k、实际按 32k 在压缩历史）必须能看到具体数值与来源。
 */
export function describeResolvedContextWindow(tokens: unknown, source: unknown): string {
  const resolved = Number(tokens)
  if (!Number.isFinite(resolved) || resolved <= 0) return '未知'
  const origin = source === 'override' ? '手动' : source === 'model-name' ? '按模型名推导' : '兜底默认'
  return `${formatAgentTokens(resolved)}（${origin}）`
}

/**
 * 展示用的 token 计数（128000 → `128k`、32768 → `32.8k`、1000000 → `1M`）。
 * 面板与对话气泡共用，避免同一份窗口在不同界面显示成不同数字。
 */
export function formatAgentTokens(tokens: unknown): string {
  const value = Number(tokens)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) {
    const millions = Math.round(value / 100_000) / 10
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1000) {
    const thousands = Math.round(value / 100) / 10
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return String(Math.floor(value))
}

/** 头尾都保留的有界切片；结果长度不超过 maxChars。两条截断路径共用同一算法。 */
function cutKeepingEnds(value: string, maxChars: number): string {
  const limit = Math.max(16, Math.floor(maxChars))
  if (value.length <= limit) return value
  const tail = Math.min(Math.max(24, Math.floor(limit * 0.42)), Math.max(0, limit - 17))
  if (tail <= 0) return `${value.slice(0, limit - 1)}…`
  const head = Math.max(0, limit - tail - 1)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/**
 * Head+tail truncate text so the result is guaranteed to fit a token budget.
 * The end is kept because prompts there usually carry the latest
 * result/exception; the marker makes the cut visible to the model.
 */
export function truncateTextToTokens(text: string, maxTokens: number): string {
  const value = String(text || '')
  if (!value) return ''
  const budget = clampInt(maxTokens, 16, 1_500_000)
  return cutKeepingEnds(value, Math.max(16, Math.floor(budget * 1.35)))
}

/**
 * 两遍分配的第二遍：在不超 token 预算的前提下尽量多留正文。
 *
 * `estimateAgentChars` 按最坏情况（全中文，1 token ≈ 1.35 字）折算字符预算，用它
 * 直接切片对中文是贴合实际的，但对拉丁/JSON 为主的内容只用到约 1/2.7 的容量，而
 * 最终 `compactAgentPrompt` 只会缩不会放，欠填充就固化下来了。这里先用保守切片
 * 兜住“绝不超预算”，再用真实估算二分放大到刚好放得下：中文内容基本不变，
 * 拉丁内容能多用一倍以上容量。
 */
export function fitTextToTokens(text: string, maxTokens: number): string {
  const value = String(text || '')
  if (!value) return ''
  const budget = clampInt(maxTokens, 16, 1_500_000)
  if (estimateAgentTokens(value) <= budget) return value
  // 保守切片已知放得下（下界），原文已知放不下（上界），在此区间二分找最大可容纳切片。
  let best = cutKeepingEnds(value, Math.max(16, Math.floor(budget * 1.35)))
  let low = best.length
  let high = value.length
  for (let step = 0; step < 24 && high - low > 1; step++) {
    const middle = Math.floor((low + high) / 2)
    const candidate = cutKeepingEnds(value, middle)
    if (estimateAgentTokens(candidate) <= budget) {
      best = candidate
      low = candidate.length
    } else {
      high = middle
    }
  }
  return best
}

/** Allocate input/output space while leaving a safety margin for provider framing. */
export function resolveAgentContextBudget(input: {
  provider: string
  model: string
  contextWindowTokens?: number | null
  requestedOutputTokens?: number
  profileMaxTokens?: number
}): AgentContextBudget {
  const resolved = resolveModelContextWindow(input.provider, input.model, input.contextWindowTokens)
  const safety = clampInt(Math.ceil(resolved.tokens * 0.04), 1024, 8192)
  const requested = Number(input.requestedOutputTokens ?? input.profileMaxTokens ?? 1200)
  const profileMaxRaw = Number(input.profileMaxTokens ?? requested)
  const profileMax = Number.isFinite(profileMaxRaw) && profileMaxRaw >= 16 ? profileMaxRaw : 1200
  const outputFloor = Math.min(256, Math.max(16, profileMax))
  const outputTokens = clampInt(Math.min(requested, profileMax, Math.floor(resolved.tokens * 0.3)), outputFloor, Math.max(outputFloor, resolved.tokens - safety - 512))
  const maxInputTokens = Math.max(1024, resolved.tokens - outputTokens - safety)
  const maxInputChars = estimateAgentChars(maxInputTokens)
  return {
    contextWindowTokens: resolved.tokens,
    source: resolved.source,
    maxInputTokens,
    outputTokens,
    maxInputChars,
    historyChars: clampInt(Math.floor(maxInputChars * 0.28), 1800, 72000),
    memoryChars: clampInt(Math.floor(maxInputChars * 0.18), 1600, 36000),
    jobResultsChars: clampInt(Math.floor(maxInputChars * 0.2), 1600, 36000)
  }
}

function compactTurnText(text: string, maxChars: number): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const limit = clampInt(maxChars, 16, 120000)
  // 保留首尾但绝不超限：调用方用这些切片做 token 预算核算，近似截断会破坏账目。
  return cutKeepingEnds(value, limit)
}

/**
 * 按**token**预算压缩一段已知正文（两遍分配：保守切片 → 真实估算回填）。
 *
 * maxChars 是预算侧按最坏情况给出的字符份额，这里换算回对应的 token 份额后再填充，
 * 因此拉丁/JSON 为主的内容不会被白扔掉一半以上容量。
 */
export function compactTextForContext(text: string, maxChars: number): string {
  const limit = clampInt(maxChars, 120, 120000)
  return fitTextToTokens(text, Math.max(16, Math.floor(limit / 1.35)))
}

/**
 * Deterministic, evenly spaced sample of a range (first/middle/last style).
 * Used for the conversation summary so a long omitted stretch still shows its
 * middle, where decisions often sit, instead of only its head and tail.
 */
function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count || count <= 0) return items.slice()
  const picked: T[] = []
  for (let index = 0; index < count; index++) {
    const item = items[Math.round((index * (items.length - 1)) / (count - 1))]
    if (item !== undefined && !picked.includes(item)) picked.push(item)
  }
  return picked
}

/**
 * Keep recent turns verbatim-ish and replace omitted older turns with a small
 * deterministic summary.  This avoids an extra paid model call and makes
 * compression repeatable after a renderer reload.
 */
export function compressAgentHistory(history: AgentConversationTurn[], maxChars: number): AgentConversationTurn[] {
  const clean = history
    .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .map(turn => ({ role: turn.role, text: compactTurnText(turn.text, 2200) }))
    .filter(turn => turn.text.length > 0)
  if (!clean.length) return []

  const budget = clampInt(maxChars, 1200, 120000)
  const recent: AgentConversationTurn[] = []
  let used = 0
  for (let index = clean.length - 1; index >= 0; index--) {
    const turn = clean[index]
    const text = compactTurnText(turn.text, Math.min(1800, Math.max(240, budget - used)))
    const cost = text.length + 24
    if (recent.length >= 32 || used + cost > budget) break
    recent.unshift({ role: turn.role, text })
    used += cost
  }
  const omitted = clean.length - recent.length
  if (omitted <= 0) return recent

  const old = clean.slice(0, omitted)
  const samples = sampleEvenly(old, 4)
  const summary = samples
    .map(turn => `${turn.role === 'user' ? '用户' : '助手'}：${compactTurnText(turn.text, 180)}`)
    .join('；')
  let summaryText = compactTurnText(`【系统生成的对话压缩摘要，仅作上下文】已省略 ${omitted} 轮；${summary}`, Math.min(800, Math.floor(budget * 0.35)))
  while (recent.length > 1 && summaryText.length + recent.reduce((total, turn) => total + turn.text.length + 24, 0) > budget) recent.shift()
  // Shrinking the kept turns changes how many turns are actually omitted;
  // keep the summary count truthful so the model cannot misjudge scope.
  const finalOmitted = clean.length - recent.length
  if (finalOmitted !== omitted) summaryText = summaryText.replace(`已省略 ${omitted} 轮`, `已省略 ${finalOmitted} 轮`)
  if (recent.length) {
    const remaining = Math.max(120, budget - summaryText.length - 24)
    recent[0] = { ...recent[0], text: compactTurnText(recent[0].text, remaining) }
  }
  const compressed: AgentConversationTurn = {
    role: 'assistant',
    text: summaryText
  }
  return [compressed, ...recent]
}

type CompactPriority = 'goal' | 'instruction' | 'conversationHistory' | 'approvedMemory' | 'jobResults' | 'currentPageObservation' | 'previousResults'

/**
 * Heavier keys keep a larger share when one JSON request has to be squeezed.
 * Without this the goal/instruction (the only fields the model must follow)
 * would be truncated as aggressively as reproducible collections such as
 * `stores` or `skills`.  Unknown keys stay neutral.
 */
const COMPACT_PRIORITY_WEIGHT: Record<CompactPriority, number> = {
  goal: 6,
  instruction: 6,
  conversationHistory: 3,
  approvedMemory: 3,
  jobResults: 3,
  currentPageObservation: 2,
  previousResults: 2
}

function compactPriorityWeight(key: string): number {
  return COMPACT_PRIORITY_WEIGHT[key as CompactPriority] ?? 1
}

function compactJsonValue(value: unknown, tokenBudget: number, depth = 0): unknown {
  const budget = clampInt(tokenBudget, 96, 240000)
  if (typeof value === 'string') return truncateTextToTokens(value, Math.min(12000, budget))
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 8) return typeof value === 'object' ? '[已压缩]' : String(value)

  if (Array.isArray(value)) {
    if (!value.length) return []
    const maxItems = Math.max(1, Math.min(value.length, Math.floor(budget / 180)))
    const head = Math.ceil(maxItems / 2)
    const tail = Math.max(0, maxItems - head)
    const selected = value.slice(0, head).concat(tail ? value.slice(-tail) : [])
    const itemBudget = Math.max(96, Math.floor(budget / Math.max(1, selected.length)))
    return selected.map(item => compactJsonValue(item, itemBudget, depth + 1))
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return {}
  const totalWeight = entries.reduce((total, [key]) => total + compactPriorityWeight(key), 0)
  const floor = Math.max(32, Math.min(96, Math.floor(budget / entries.length)))
  const output: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    const share = Math.floor((budget * compactPriorityWeight(key)) / Math.max(1, totalWeight))
    output[key] = compactJsonValue(item, Math.max(floor, share), depth + 1)
  }
  return output
}

/**
 * Keep a model request JSON-shaped while fitting it into the effective input
 * budget.  Callers usually build a rich object containing history, memory and
 * task evidence; truncating the serialized string would produce invalid JSON
 * and make the model lose the field names it needs to act safely.  This helper
 * progressively compacts strings/arrays/objects and only drops optional empty
 * collections as a last resort.
 */
export function compactAgentPrompt(value: string, maxTokens: number): string {
  const raw = String(value || '')
  const budget = clampInt(maxTokens, 128, 1_500_000)
  if (estimateAgentTokens(raw) <= budget) return raw

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return truncateTextToTokens(raw, budget) }

  // The token estimator is intentionally conservative for Chinese/JSON.  Use
  // several passes so a long object remains valid even when its fields contain
  // mostly CJK text rather than Latin JSON keys.
  for (let pass = 0; pass < 8; pass++) {
    const scale = Math.pow(0.72, pass)
    const candidate = compactJsonValue(parsed, Math.max(512, Math.floor(budget * 1.6 * scale)))
    const serialized = JSON.stringify(candidate)
    if (serialized && estimateAgentTokens(serialized) <= budget) return serialized
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const fallback = { ...(parsed as Record<string, unknown>) }
    // These fields are useful evidence but are reproducible from the current
    // software snapshot. Keep the goal/instruction and preserve valid JSON.
    for (const key of ['previousResults', 'approvedMemory', 'jobResults', 'conversationHistory', 'currentPageObservation', 'backups', 'trashStores', 'recentTasks', 'skills', 'jobs', 'agents', 'stores']) {
      if (!(key in fallback)) continue
      fallback[key] = Array.isArray(fallback[key]) ? [] : ''
      const serialized = JSON.stringify(fallback)
      if (serialized && estimateAgentTokens(serialized) <= budget) return serialized
    }
    const compacted = compactJsonValue(fallback, Math.max(512, Math.floor(budget * 1.1)))
    const serialized = JSON.stringify(compacted)
    if (serialized && estimateAgentTokens(serialized) <= budget) return serialized
  }

  // Last resort that still preserves field names: compact hard, and verify.
  const validJson = JSON.stringify(compactJsonValue(parsed, Math.max(256, Math.floor(budget * 0.8))))
  if (validJson && estimateAgentTokens(validJson) <= budget) return validJson

  // A valid-JSON payload that is still over budget would be rejected by the
  // provider, so fall back to a bounded (non-JSON) prompt instead of failing
  // the request outright.
  return truncateTextToTokens(raw, budget)
}
