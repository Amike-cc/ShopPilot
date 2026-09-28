/**
 * 记忆规则（纯函数：不依赖 electron、数据库、文件系统）。
 *
 * 为什么单独成文件：这些规则原本和 Main 的 I/O、加密、审核混在
 * `agent-memory.ts` 里，导致「学什么、怎么召回、什么算重复」完全无法脱离
 * Electron 做单测（单测里 import 该文件会连带拉起 electron 和 better-sqlite3）。
 * 这里只保留确定性判断，I/O、审核、脱敏写入仍然只在 Main 执行。
 */
import { AGENT_MEMORY_TYPES } from './schemas/agent-domain'
import { redactAgentText } from './agent-privacy'

export type AgentMemoryType = (typeof AGENT_MEMORY_TYPES)[number]

/**
 * 每种记忆类型的正文上限（字符）。用 Record<AgentMemoryType, number> 声明：
 * 以后往 AGENT_MEMORY_TYPES 加类型时这里会直接编译失败，不会再出现
 * 「契约里有 / 实现里没有」的死分支（旧代码里的 working 就是这种情况）。
 */
export const MEMORY_TYPE_LIMITS: Record<AgentMemoryType, number> = {
  semantic: 32768,
  procedural: 32768,
  episodic: 16384,
  shared: 32768
}

export function memoryTypeLimit(type: string): number {
  return (MEMORY_TYPE_LIMITS as Record<string, number | undefined>)[type] ?? MEMORY_TYPE_LIMITS.semantic
}

/** 学习文本归一化：控制字符/换行压平 + 脱敏 + 截断。 */
export function normalizeLearningText(value: unknown, max = 2000): string {
  return redactAgentText(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
}

/** 只有明确表达「长期保留」的语言才会成为候选；普通闲聊不学习。 */
export const DURABLE_CUE_RE = /(记住|记下|请记|以后|今后|默认|偏好|我喜欢|我不喜欢|不要|禁止|必须|规则|习惯|长期|下次|每次|总是|永远|保留|称呼我)/i

/** 明确的「不要记住」优先于其它线索：用户撤销记忆时不能再产生候选。 */
export const FORGET_CUE_RE = /(忘记|删除记忆|清除记忆|不要记住|别记住)/i

/** 规则/流程类表达 → procedural；其余偏好陈述 → semantic。 */
export const PROCEDURAL_CUE_RE = /(不要|禁止|必须|规则|流程|每次|总是|默认)/i

/** 强表达用于置信度分级。 */
const STRONG_DURABLE_CUE_RE = /(记住|请记|必须|禁止|默认)/i

/** 一句话至少要有这么多字才算可学，避免把「好的」「记住了」学成记忆。 */
export const MEMORY_STATEMENT_MIN_CHARS = 8
/** 单条消息最多切出几句候选。 */
export const MEMORY_STATEMENT_MAX_PER_MESSAGE = 4
/** 单个回合最多产生多少条候选。 */
export const MEMORY_STATEMENT_MAX_PER_TURN = 8
/** 单条消息参与学习的最大长度。 */
export const MEMORY_LEARNING_TEXT_MAX_CHARS = 1800

export interface DurableMemoryCandidate {
  statement: string
  type: 'semantic' | 'procedural'
  confidence: number
  title: string
}

/**
 * 从对话里抽取「持久性表达」。刻意保守：只认明确的长期语言线索，
 * 结果仍然要以 pending-review 落库，绝不会直接进入模型提示词。
 */
export function extractDurableMemoryCandidates(
  messages: ReadonlyArray<{ role: string; text: string }>,
  options: { maxPerMessage?: number; maxStatements?: number; maxChars?: number } = {}
): DurableMemoryCandidate[] {
  const maxPerMessage = Math.max(1, Math.floor(options.maxPerMessage ?? MEMORY_STATEMENT_MAX_PER_MESSAGE))
  const maxStatements = Math.max(1, Math.floor(options.maxStatements ?? MEMORY_STATEMENT_MAX_PER_TURN))
  const maxChars = Math.max(MEMORY_STATEMENT_MIN_CHARS, Math.floor(options.maxChars ?? MEMORY_LEARNING_TEXT_MAX_CHARS))
  const statements: string[] = []
  for (const message of messages || []) {
    if (message?.role !== 'user') continue
    const text = normalizeLearningText(message.text, maxChars)
    if (!text || FORGET_CUE_RE.test(text)) continue
    if (!DURABLE_CUE_RE.test(text)) continue
    const parts = text
      .split(/[。！？!?；;\n]+/)
      .map(item => item.trim())
      .filter(item => item.length >= MEMORY_STATEMENT_MIN_CHARS)
      .slice(0, maxPerMessage)
    for (const part of parts) {
      if (!statements.includes(part)) statements.push(part)
    }
  }
  return statements.slice(-maxStatements).map(statement => ({
    statement,
    type: PROCEDURAL_CUE_RE.test(statement) ? 'procedural' as const : 'semantic' as const,
    confidence: STRONG_DURABLE_CUE_RE.test(statement) ? 0.78 : 0.62,
    title: `用户偏好：${statement.slice(0, 72)}`
  }))
}

/**
 * 近重复判定用的规范正文。
 *
 * FTS5 的 unicode61 在部分 SQLite 构建上把一整句中文当成一个 token，所以除
 * 关键词外再存**字符 bigram**：中文换空格、换标点、简繁差异之外的同一条规则，
 * 应该能在自动学习时被判成同一条记忆，而不是无限堆积。
 *
 * 超过 maxChars 的正文返回 null：宁可不去重，也不能把两条长任务记录
 * （例如两次不同 Job 的 episodic 证据）误判成同一条而丢证据。
 */
export const MEMORY_DEDUPE_MAX_CHARS = 2000

export function memoryDedupeText(content: unknown, maxChars = MEMORY_DEDUPE_MAX_CHARS): string | null {
  const raw = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > maxChars) return null
  const canonical = normalizeLearningText(raw, maxChars + 1)
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  if (!canonical) return null
  return canonical
}

/** 索引侧关键词：原词 + 有界字符 bigram。纯本地词法索引，不外发记忆正文。 */
export function memoryKeywords(value: string): string {
  const normalized = String(value || '').toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || []
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '')
  const bigrams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2))
  return Array.from(new Set([...words, ...bigrams])).filter(token => token.length >= 2).slice(0, 800).join(' ')
}

/** 查询侧 token：剥掉 FTS5 语法字符，同样补 bigram 以便中文命中。 */
export function memoryQueryTokens(value: string): string[] {
  const normalized = String(value || '').toLowerCase().replace(/["*:^()]/g, ' ').trim()
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || []
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '')
  const bigrams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2))
  return Array.from(new Set([...words, ...bigrams])).filter(token => token.length >= 2).slice(0, 24)
}

export interface MemoryScoreInput {
  title?: unknown
  content?: unknown
  type?: unknown
  scope?: unknown
  confidence?: unknown
  updatedAt?: unknown
  adoptCount?: unknown
  rejectCount?: unknown
  lastHitAt?: unknown
}

/**
 * 召回打分：关键词重叠 + 类型权重 + 范围权重 + 置信度 + 新鲜度 + 反馈自适应 + 命中新鲜度。
 * 显式传 now 是为了让「新鲜度」可以在单测里被确定性地验证。
 */
export function memoryContextScore(row: MemoryScoreInput, terms: readonly string[], now = Date.now()): number {
  const title = String(row.title || '').toLowerCase()
  const body = String(row.content || '').toLowerCase()
  const overlap = (terms || []).reduce((score, term) => score + (title.includes(term) ? 3 : body.includes(term) ? 1 : 0), 0)
  const typeWeight = row.type === 'procedural' ? 2.2 : row.type === 'semantic' ? 1.8 : row.type === 'shared' ? 1.2 : 1
  const scopeWeight = row.scope === 'store' ? 1.5 : row.scope === 'private' ? 1.2 : 1
  const confidence = Math.max(0, Math.min(1, Number(row.confidence || 0)))
  const ageDays = Math.max(0, (now - Number(row.updatedAt || 0)) / 86400000)
  const freshness = 1 / (1 + ageDays / 30)
  const adopted = Number(row.adoptCount || 0)
  const rejected = Number(row.rejectCount || 0)
  const feedback = Math.sqrt(adopted + rejected + 1)
  const adaptive = (adopted * 0.8 - rejected * 1.1) / feedback
  const hitFreshness = row.lastHitAt ? 1 / (1 + Math.max(0, (now - Number(row.lastHitAt)) / 86400000) / 14) : 0
  return overlap * 5 + typeWeight + scopeWeight + confidence * 2 + freshness + adaptive + hitFreshness
}
