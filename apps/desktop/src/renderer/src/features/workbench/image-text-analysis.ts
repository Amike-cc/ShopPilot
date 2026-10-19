/**
 * 生图文本 API 的商品分析（纯逻辑，零 vue / electron / DOM）
 *
 * 背景：设置中心的「生图文本 API」明确写着「仅用于 AI 生成商品图片页面的商品分析和提示词整理」，
 * 主进程 `AI_IMAGE_TEXT_ANALYZE`（含输入校验、审计、vision 读图回退）与 preload 都已就绪，
 * 但渲染层从来没调用过——用户配了 Key 却什么都没发生。这里把「怎么组参 / 结果怎么清洗 /
 * 错误怎么说人话」抽成纯函数，页面只负责取状态、发请求、写回输入框。
 *
 * 与主进程 ai-handlers 的口径保持一致（那是真正的边界，这里只是提前挡住明显不合法的输入）：
 *   · 图片最多 3 张、单张 ≤ 8MB、类型只认 png / jpeg / webp；
 *   · 名称 ≤120、描述 ≤240、价格 ≤24 由主进程再截断一次；
 *   · 名称 / 描述 / 图片三者全空 → 主进程回 `AI_EMPTY_SOURCE`。
 */

/** 一次分析最多带几张图（与 ai-handlers 的 images.slice(0, 3) 一致） */
export const ANALYSIS_MAX_IMAGES = 3
/** 单张图片字节上限（与 ai-handlers 的 8MB 一致） */
export const ANALYSIS_MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 整理后的图片描述长度上限（与图片生成的 prompt ≤4000 同口径） */
export const ANALYSIS_MAX_TEXT_LENGTH = 4000

export interface AnalysisSourceImage {
  name?: string
  dataUrl?: string
  /** 调用方已知的 MIME；真正的判据仍是 dataUrl 前缀（拿不到就返回 null） */
  mimeType?: string
}

export interface AnalysisImagePayload {
  mimeType: string
  b64Json: string
}

export interface AnalysisInput {
  name?: string
  tags?: string
  price?: string
  originalPrice?: string
  images: AnalysisImagePayload[]
}

export interface AnalysisProductSource {
  productName?: string
  prompt?: string
  price?: string
  originalPrice?: string
  images?: readonly AnalysisSourceImage[]
}

/** 只认这几种 data URL：`data:image/png|jpeg|webp;base64,<payload>` */
const ANALYSIS_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i

/**
 * data URL → 主进程要的 `{ mimeType, b64Json }`。
 * 拿不到合法数据（缺字段 / 不是白名单类型 / 不是 base64 / 超 8MB）一律返回 null，由调用方丢弃。
 */
export function dataUrlToAnalysisImage(source: AnalysisSourceImage): AnalysisImagePayload | null {
  const dataUrl = typeof source?.dataUrl === 'string' ? source.dataUrl.trim() : ''
  const match = ANALYSIS_DATA_URL.exec(dataUrl)
  if (!match) return null
  const b64Json = match[2]
  // 与 ai-handlers 相同的估算方式：base64 长度 × 3/4
  if (Math.ceil(b64Json.length * 3 / 4) > ANALYSIS_MAX_IMAGE_BYTES) return null
  return { mimeType: `image/${match[1].toLowerCase()}`, b64Json }
}

/** trim 后非空才带上，避免把空串当字段发给主进程 */
function optionalText(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || undefined
}

/**
 * 组装 `ai.analyzeImageProduct` 的入参：文本字段 trim 后为空就不传，
 * 图片最多取 `ANALYSIS_MAX_IMAGES` 张合法的（非法项直接丢，不做占位）。
 */
export function buildAnalysisInput(input: AnalysisProductSource): AnalysisInput {
  const images: AnalysisImagePayload[] = []
  for (const source of input?.images || []) {
    if (images.length >= ANALYSIS_MAX_IMAGES) break
    const image = dataUrlToAnalysisImage(source)
    if (image) images.push(image)
  }
  const result: AnalysisInput = { images }
  const name = optionalText(input?.productName)
  const tags = optionalText(input?.prompt)
  const price = optionalText(input?.price)
  const originalPrice = optionalText(input?.originalPrice)
  if (name) result.name = name
  if (tags) result.tags = tags
  if (price) result.price = price
  if (originalPrice) result.originalPrice = originalPrice
  return result
}

/**
 * 有没有可分析的东西：非空商品名 / 非空描述 / 至少一张合法图。
 * 判据与 `buildAnalysisInput` 完全同源（直接看组出来的 images），
 * 避免「按钮说能点、发出去却被主进程判 AI_EMPTY_SOURCE」这种自相矛盾。
 */
export function canAnalyzeProduct(input: AnalysisProductSource): boolean {
  if (optionalText(input?.productName) || optionalText(input?.prompt)) return true
  return buildAnalysisInput({ images: input?.images }).images.length > 0
}

/**
 * 清洗模型返回的描述：trim → 去掉包裹的 ``` 围栏 → 折叠 3 个以上连续空行 → 超长截断。
 * 空/纯空白/只有围栏 → `''`（调用方据此提示「没有返回可用描述」）。
 */
export function analysisPromptText(text: string): string {
  let value = typeof text === 'string' ? text.trim() : ''
  if (!value) return ''
  // 统一换行 + 去掉行尾空白：只有空格的行在用户看来也是空行，"3 个空行"必须按视觉算
  value = value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '')
  // 开头/结尾各自的围栏行（容忍模型少写一半围栏、或围栏后带 json 之类的语言标记）
  value = value.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
  if (!value) return ''
  value = value.replace(/\n{3,}/g, '\n\n')
  if (value.length > ANALYSIS_MAX_TEXT_LENGTH) value = value.slice(0, ANALYSIS_MAX_TEXT_LENGTH).trim()
  return value
}

/**
 * 把失败信封（`{ code, message }` / 字符串 / 异常）翻成可执行的中文提示。
 *
 * 分层纪律（2026-10-18 独立复验 F2）：**主进程已经本地化过的中文文案一律原样透传**。
 * 主进程 `services/ai-failure-text.ts` 会把网络/超时/凭据/限流/5xx 等底层原因翻成可执行中文；
 * 这里再包一层前缀就会变成「AI 商品分析失败：连不上 AI 接口：…（原始错误：fetch failed）」这种三层套娃。
 * 本函数只负责主进程覆盖不到的语义（空来源）与"主进程给的是英文裸串"的兜底。
 */
export function describeAnalysisError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : typeof error === 'object' && error !== null
        ? ''
        : String(error ?? '')
  const detail = message.replace(/^[A-Z_]+:\s*/, '').trim()
  const haystack = `${code} ${detail}`

  // ① 主进程已经给了中文可执行文案 → 原样显示，不再加前缀、不再二次映射
  if (/[\u4e00-\u9fa5]/.test(detail)) return detail
  // ② 主进程覆盖不到的语义：空来源
  if (/AI_EMPTY_SOURCE|EMPTY_SOURCE|请先上传商品图/i.test(haystack)) {
    return '请先上传商品图或填写商品名称/卖点'
  }
  // ③ 未配置（主进程正常会给中文；这里兜底它万一只回码的情况）
  if (/AI_(IMAGE_TEXT|IMAGE)?_?NOT_CONFIGURED|not configured/i.test(haystack)) {
    return '生图文本 API 未配置，请到设置中心 → AI 配置页填写'
  }
  // ④ 英文裸串兜底
  const summary = detail.slice(0, 120)
  return summary ? `AI 商品分析失败：${summary}` : 'AI 商品分析失败，请稍后重试'
}
