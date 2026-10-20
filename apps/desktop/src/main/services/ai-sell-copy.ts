/**
 * 图文带货文案生成的纯逻辑 —— 2026-10-19
 *
 * 位置：`main/services`，但**不允许 import electron / db / logger**。原因：
 *   ① 输入清洗、提示词组装、模型 JSON 输出解析都是纯规则，必须能被 vitest 直接 import 单测；
 *   ② 提示词固定在本文件，渲染层只能提交受限结构化字段（productName / platform / images …），
 *      不能注入任意 system 指令——这是主进程与渲染层的安全边界。
 *
 * 边界：
 * - 所有长度 / 数量 / 类型白名单以 `@shared/contracts/ai-sell-copy` 为唯一事实来源，不在这里另写一份；
 * - 校验失败**不抛 AiError**（避免 ai-client ⇄ 本文件 的循环依赖）：返回 `{ ok:false, code, message }`，
 *   由 `ai-client.generateSellCopyText` 统一包成 AiError；
 * - 模型输出一律当不可信文本处理：先尝试 JSON，解析失败走文本兜底，字段再逐项清洗 / 截断 / 补齐。
 */

import {
  SELL_COPY_IMAGE_MIME_TYPES,
  SELL_COPY_LIMITS,
  clampSellCopyImageCount,
  normalizeSellCopyPlatform,
  normalizeSellCopyStyle,
  type SellCopyImageMimeType,
  type SellCopyPlatform,
  type SellCopyStyle
} from '@shared/contracts/ai-sell-copy'

/** 清洗后可直接进主进程请求的输入（渲染层只能通过结构化字段影响它）。 */
export interface NormalizedSellCopyInput {
  productName: string
  sellingPoints: string
  price: string
  originalPrice: string
  audience: string
  platform: SellCopyPlatform
  style: SellCopyStyle
  /** 已夹到 1–9；同时决定 imagePrompts 的条数 */
  imageCount: number
  /** 已过滤：白名单 MIME、非空 base64、单张 ≤ SELL_COPY_LIMITS.maxImageBytes、最多 maxImages 张 */
  images: Array<{ mimeType: SellCopyImageMimeType; b64Json: string }>
}

export type SellCopyNormalizeResult =
  | { ok: true; input: NormalizedSellCopyInput }
  | { ok: false; code: string; message: string }

/** 交给 chatCompleteForImageText 的一次性参数；提示词由本文件组装，调用方不可覆盖。 */
export interface SellCopyMessages {
  system: string
  user: string
  maxTokens: number
}

/** 模型输出清洗后的带货笔记正文（不含 model/elapsedMs 等调用元信息）。 */
export interface SellCopyOutput {
  title: string
  body: string
  tags: string[]
  coverText: string
  imagePrompts: string[]
}

/** 与 ai-handlers 里 `AI_EMPTY_SOURCE` 分流的口径一致：既无文字来源、也没有一张可用图。 */
const EMPTY_SOURCE_CODE = 'AI_EMPTY_SOURCE'
const EMPTY_SOURCE_MESSAGE = '请先上传商品图，或填写商品名称/卖点，再生成带货文案'

/** 建议输出预算：标题 + 正文 + 话题 + 逐图描述，1400 对主流模型够用且不至于被截断。 */
const SELL_COPY_MAX_TOKENS = 1400

/** 输入字段：字符串或数字都当文本（渲染层传 199 这种数字价格不该整单失败），其它类型视为空。 */
function readInputText(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return value.trim().slice(0, maxLength)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).trim().slice(0, maxLength)
  return ''
}

/** 模型输出字段只认字符串：数组 / 对象 / 数字都不是合法的"标题/正文"。 */
function readModelText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** base64 体积估算与 ai-handlers / renderer 现有口径一致（不实际解码，避免大图卡主进程）。 */
function estimateBase64Bytes(b64Json: string): number {
  return Math.ceil(b64Json.length * 3 / 4)
}

/** 图片清洗：最多 maxImages 张，白名单 MIME，非空 base64，单张体积不超上限；非法项跳过。 */
function normalizeImages(value: unknown): NormalizedSellCopyInput['images'] {
  if (!Array.isArray(value)) return []
  const allowedMimeTypes = new Set<string>(SELL_COPY_IMAGE_MIME_TYPES)
  const images: NormalizedSellCopyInput['images'] = []
  for (const item of value) {
    if (images.length >= SELL_COPY_LIMITS.maxImages) break
    if (!item || typeof item !== 'object') continue
    const record = item as { mimeType?: unknown; b64Json?: unknown }
    const mimeType = String(record.mimeType ?? '').split(';')[0].trim().toLowerCase()
    if (!allowedMimeTypes.has(mimeType)) continue
    // 只认字符串：对象/数字 String() 出来的 "[object Object]" 会被当成 base64 发给模型
    if (typeof record.b64Json !== 'string') continue
    let b64Json = record.b64Json.trim()
    if (!b64Json) continue
    // 契约要求传纯 base64；这里额外容忍渲染层误传 data URL（只取逗号后的内容），不让用户白丢图。
    if (/^data:[^,]*;base64,/i.test(b64Json)) b64Json = b64Json.slice(b64Json.indexOf(',') + 1).trim()
    if (!b64Json) continue
    if (estimateBase64Bytes(b64Json) > SELL_COPY_LIMITS.maxImageBytes) continue
    images.push({ mimeType: mimeType as SellCopyImageMimeType, b64Json })
  }
  return images
}

/**
 * 渲染层输入 → 主进程安全输入。
 *
 * 脏值策略：文本字段 trim + 截断、平台/风格回落到默认值、配图张数夹到 1–9、非法图片直接跳过。
 * 只有「商品名 / 卖点 / 图片」三者全空才拒绝——价格、原价、人群都只是辅助信息，不构成可生成来源。
 */
export function normalizeSellCopyInput(raw: unknown): SellCopyNormalizeResult {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const input: NormalizedSellCopyInput = {
    productName: readInputText(source.productName, SELL_COPY_LIMITS.productName),
    sellingPoints: readInputText(source.sellingPoints, SELL_COPY_LIMITS.sellingPoints),
    price: readInputText(source.price, SELL_COPY_LIMITS.price),
    originalPrice: readInputText(source.originalPrice, SELL_COPY_LIMITS.originalPrice),
    audience: readInputText(source.audience, SELL_COPY_LIMITS.audience),
    platform: normalizeSellCopyPlatform(source.platform),
    style: normalizeSellCopyStyle(source.style),
    imageCount: clampSellCopyImageCount(source.imageCount),
    images: normalizeImages(source.images)
  }
  if (!input.productName && !input.sellingPoints && !input.images.length) {
    return { ok: false, code: EMPTY_SOURCE_CODE, message: EMPTY_SOURCE_MESSAGE }
  }
  return { ok: true, input }
}

/**
 * 组装提示词。
 *
 * system 完全固定（只允许把**已归一化的枚举值/数字**拼进去），用户文本一律只进 user：
 * 即使商品名里写着"忽略以上指令"，也只会作为商品名出现在 user 消息里。
 */
export function buildSellCopyMessages(input: NormalizedSellCopyInput): SellCopyMessages {
  const imageCount = input.imageCount
  const system = [
    '你是电商图文带货内容策划，负责把商品信息写成可直接发布到内容平台的图文带货笔记。',
    '只输出一个 JSON 对象，不要输出 Markdown 代码块、解释、前言或结语。JSON 字段固定为：',
    '{"title":"笔记标题","body":"笔记正文","tags":["话题1","话题2"],"coverText":"封面大字","imagePrompts":["第 1 张图的画面描述"]}',
    '硬性要求：',
    `1. title ≤ ${SELL_COPY_LIMITS.title} 字，不带话题标签、不带引号；`,
    `2. body ≤ ${SELL_COPY_LIMITS.body} 字，可含换行，按目标平台的图文笔记语言习惯分段；`,
    `3. tags 为 3–${SELL_COPY_LIMITS.tags} 条话题，去掉 # 前缀，每条 ≤ ${SELL_COPY_LIMITS.tag} 字；`,
    `4. coverText 是封面大字 / 首图贴纸文案，≤ ${SELL_COPY_LIMITS.coverText} 字，不要引号；`,
    `5. imagePrompts 必须正好 ${imageCount} 条，每条 ≤ ${SELL_COPY_LIMITS.imagePrompt} 字，是可直接用于文生图的画面描述：写清主体、场景、构图、光线与色调；画面要为封面排版留出留白，不要在图中生成文字、水印、品牌标识或平台 Logo；`,
    '6. 不夸大功效，不编造数据、销量、评价、认证或价格；用户没有提供的金额、规格、成分与功效一律不要出现；',
    '7. 以用户消息里的商品信息与图片为唯一事实来源，看不到或不确定的内容不要补写。'
  ].join('\n')

  const user = [
    `发布平台：${input.platform}`,
    `笔记风格：${input.style}`,
    `期望配图数量：${imageCount} 张（imagePrompts 必须正好 ${imageCount} 条）`,
    input.productName
      ? `商品名称：${input.productName}`
      : '商品名称：未提供（不要编造品牌或型号，只根据其它信息与图片描述）',
    input.sellingPoints ? `卖点/标签：${input.sellingPoints}` : '',
    input.price ? `用户填写售价：${input.price}` : '',
    input.originalPrice ? `用户填写原价：${input.originalPrice}` : '',
    input.audience ? `目标人群/使用场景：${input.audience}` : '',
    input.images.length ? `随本次请求附上 ${input.images.length} 张商品图片，请以图片里真实可见的内容为准。` : ''
  ].filter(Boolean).join('\n')

  return { system, user, maxTokens: SELL_COPY_MAX_TOKENS }
}

/** 单行清洗：压平换行/连续空白、去掉包裹引号，再按上限截断。 */
function cleanInline(value: unknown, maxLength: number): string {
  return readModelText(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, maxLength)
}

/** 正文清洗：保留换行，去掉行尾空白，把 3 个以上连续空行折成一个空行，再截断。 */
function cleanBody(value: unknown, maxLength: number): string {
  const text = readModelText(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
  return text.replace(/\n{3,}/g, '\n\n').slice(0, maxLength)
}

/** 单个话题清洗：去 # 前缀 / 引号 / 内部空白，每条 ≤ tag 上限。 */
function cleanTag(value: unknown): string {
  return readModelText(value)
    .replace(/^[#＃]+/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, SELL_COPY_LIMITS.tag)
}

/**
 * 话题列表清洗：去 # 前缀、去空、去重（保持顺序）、每条 ≤ 20 字、最多 8 条。
 * 容忍模型把多个话题塞在一个数组元素里（`"#秋冬穿搭 #露营"`）或直接把 tags 写成字符串。
 */
function normalizeTags(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[,，、;；\s]+/) : []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of items) {
    for (const part of readModelText(item).split(/[,，、;；#＃]+/)) {
      const tag = cleanTag(part)
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
      if (tags.length >= SELL_COPY_LIMITS.tags) return tags
    }
  }
  return tags
}

/** 单张图的画面描述清洗：压成一行、去首尾空白、按上限截断。 */
function cleanImagePrompt(value: unknown): string {
  return readModelText(value).replace(/\s+/g, ' ').trim().slice(0, SELL_COPY_LIMITS.imagePrompt)
}

/** 模型少给画面描述时的占位描述：可直接拿去生图，且同样要求留白 / 不生成文字。 */
function placeholderImagePrompt(input: NormalizedSellCopyInput, index: number): string {
  const subject = (input.productName || input.sellingPoints.split(/[，,、;；\s]+/)[0] || '商品').slice(0, 20)
  return `第 ${index + 1} 张：${subject}主体展示图，干净背景、柔和自然光，构图留出排版留白，画面中不出现文字、水印或品牌标识`
}

/**
 * imagePrompts 清洗后必须**正好** imageCount 条：先清洗 / 过滤 / 截断，不够用占位描述补齐。
 * 渲染层据此逐张生图，条数少了会少图、多了会白花钱，所以这里不对条数做"尽量"处理。
 */
function normalizeImagePrompts(value: unknown, input: NormalizedSellCopyInput): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const prompts = items.map(cleanImagePrompt).filter(Boolean).slice(0, input.imageCount)
  for (let index = prompts.length; index < input.imageCount; index += 1) {
    prompts.push(placeholderImagePrompt(input, index))
  }
  return prompts
}

/** 取第一个 `{` 到最后一个 `}`：容忍 ```json 围栏与前后说明文字；解析失败返回 null。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 标题的最后兜底：模型输出实在没有任何可用文字时，用商品信息撑住，再不行给一个通用标题。
 * 界面约定「title 或 body 至少一个非空」——空标题会被当成"返回内容不完整"报错，不能把这种结果交出去。
 */
function guaranteedTitle(input: NormalizedSellCopyInput, preferred: string): string {
  return preferred
    || input.productName.slice(0, SELL_COPY_LIMITS.title)
    || cleanInline(input.sellingPoints.split('\n')[0] ?? '', SELL_COPY_LIMITS.title)
    || '好物推荐'
}

/** 文本兜底：标题=首行截断，正文=剩余文本，话题为空，封面文案取商品名前 20 字。 */
function fallbackSellCopyOutput(text: string, input: NormalizedSellCopyInput): SellCopyOutput {
  const cleaned = text
    .replace(/```[a-zA-Z]*\s*/g, '')
    .replace(/```/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean)
  const title = guaranteedTitle(input, cleanInline(lines[0] ?? '', SELL_COPY_LIMITS.title))
  const body = lines.slice(1).join('\n').slice(0, SELL_COPY_LIMITS.body)
  return {
    title,
    body,
    tags: [],
    coverText: (input.productName || title).slice(0, SELL_COPY_LIMITS.coverText),
    imagePrompts: normalizeImagePrompts([], input)
  }
}

/**
 * 解析模型输出。
 *
 * 顺序：取 JSON → 逐字段清洗 → 结构化兜底（JSON 里一个认识字段都没有时，用商品信息撑住外观）
 * → 文本兜底（连 JSON 都解析不出来：标题=首行、正文=剩余文本）。
 */
export function parseSellCopyOutput(rawText: string, input: NormalizedSellCopyInput): SellCopyOutput {
  const text = String(rawText ?? '').trim()
  const parsed = parseJsonObject(text)
  if (!parsed) return fallbackSellCopyOutput(text, input)

  const rawTitle = cleanInline(parsed.title, SELL_COPY_LIMITS.title)
  const body = cleanBody(parsed.body, SELL_COPY_LIMITS.body)
  const tags = normalizeTags(parsed.tags)
  const coverText = cleanInline(parsed.coverText, SELL_COPY_LIMITS.coverText)
  const rawPromptItems = Array.isArray(parsed.imagePrompts)
    ? parsed.imagePrompts
    : typeof parsed.imagePrompts === 'string' ? [parsed.imagePrompts] : []
  const hasUsableField = Boolean(rawTitle || body || tags.length || coverText || rawPromptItems.map(cleanImagePrompt).some(Boolean))

  // JSON 合法但字段全是脏类型/未知字段：不要拿整段 JSON 当标题，退回用商品信息撑住可展示结果。
  if (!hasUsableField) {
    const fallbackTitle = guaranteedTitle(input, '')
    return {
      title: fallbackTitle,
      body: '',
      tags,
      coverText: (input.productName || fallbackTitle).slice(0, SELL_COPY_LIMITS.coverText),
      imagePrompts: normalizeImagePrompts([], input)
    }
  }

  // 标题 / 封面缺失时用正文或商品信息兜底，避免界面出现空标题、空封面。
  const title = guaranteedTitle(
    input,
    rawTitle || cleanInline(body.split('\n')[0] ?? '', SELL_COPY_LIMITS.title)
  )
  const resolvedCoverText = coverText || input.productName.slice(0, SELL_COPY_LIMITS.coverText) || title.slice(0, SELL_COPY_LIMITS.coverText)
  return {
    title,
    body,
    tags,
    coverText: resolvedCoverText,
    imagePrompts: normalizeImagePrompts(parsed.imagePrompts, input)
  }
}
