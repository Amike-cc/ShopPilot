/**
 * 图文带货工作台的纯逻辑（零 vue / electron / DOM）—— 2026-10-19
 *
 * 页面只负责取状态、发请求、把结果写回界面；「怎么组参 / 怎么判可用 / 怎么清洗模型返回 /
 * 怎么拼生图提示词 / 历史怎么落盘」全部在这里，便于 vitest 逐条钉死。
 *
 * 与主进程的口径同源：长度、张数、MIME 白名单、图片大小都取自
 * `@shared/contracts/ai-sell-copy`（主进程 handler 用同一份常量清洗），渲染层这里只是提前挡明显不合法的输入。
 */

import {
  SELL_COPY_DEFAULT_IMAGE_COUNT,
  SELL_COPY_LIMITS,
  clampSellCopyImageCount,
  normalizeSellCopyPlatform,
  normalizeSellCopyStyle,
  type SellCopyImagePayload,
  type SellCopyInput,
  type SellCopyResult,
  type SellCopySource
} from '@shared/contracts/ai-sell-copy'
import { dataUrlToAnalysisImage, type AnalysisSourceImage } from './image-text-analysis'

/** 商品素材图：最多 3 张（与文案接口读图上限一致） */
export const MAX_GRAPHIC_SELL_MATERIALS = SELL_COPY_LIMITS.maxImages
/**
 * 单张素材上传上限。主进程文案接口允许 8MB，但生图编辑端点的既有上传体验是 5MB
 * （见 UnifiedImageStudioPage 的上传文案），这里与用户可见的文案保持一致。
 */
export const MAX_GRAPHIC_SELL_MATERIAL_BYTES = 5 * 1024 * 1024

/** 与 use-image-studio-generation 的 UploadAsset 同形 */
export interface GraphicSellMaterial {
  name: string
  size: number
  dataUrl: string
}

/* ------------------------------ 下拉/选项 ------------------------------ */

export const GRAPHIC_SELL_PLATFORM_OPTIONS = [
  { key: '通用', label: '通用', note: '不按特定平台的版式语言写' },
  { key: '小红书', label: '小红书', note: '种草笔记体，首图与话题标签更关键' },
  { key: '抖音', label: '抖音', note: '短句强节奏，图文挂车' },
  { key: '快手', label: '快手', note: '口语化、接地气' },
  { key: '视频号', label: '视频号', note: '熟人信任感、生活化表达' }
] as const

export const GRAPHIC_SELL_STYLE_OPTIONS = [
  { key: '种草分享', label: '种草分享', note: '第一人称使用体验' },
  { key: '测评对比', label: '测评对比', note: '优缺点与适用人群' },
  { key: '生活方式', label: '生活方式', note: '场景氛围与日常习惯' },
  { key: '使用教程', label: '使用教程', note: '步骤化讲清怎么用' },
  { key: '促销爆款', label: '促销爆款', note: '卖点密集、强调活动' }
] as const

/** 生图接口实际只接受三种尺寸，这里暴露最常用的四种比例 */
export const GRAPHIC_SELL_RATIO_OPTIONS = [
  { key: '9:16', label: '9:16 手机竖屏（参考效果同款）' },
  { key: '3:4', label: '3:4 竖版（笔记常用）' },
  { key: '1:1', label: '1:1 方图' },
  { key: '4:3', label: '4:3 横图' }
] as const

export const GRAPHIC_SELL_IMAGE_COUNT_OPTIONS = [3, 4, 6, 9] as const

/* ------------------------------ 效果模板 ------------------------------ */
/**
 * 效果模板（2026-10-19，按用户提供的 4 张参考图拆出来）：
 * 核心效果 = 俯拍躺床构图 + 柔和床品背景 + 商品由模特自然穿戴/使用 +
 * 低饱和粉彩/清透色调 + 柔和均匀光线 + 玩偶/小猫生活化点缀 + 竖屏 9:16。
 *
 * 为什么模板在**渲染层纯模块**里：模板只影响文案/生图提示词（纯字符串），
 * 不涉及 IPC 或密钥；主进程不感知"效果模板"，避免每次调模板都要改契约。
 */
export type GraphicSellEffectKey = 'bed-lying' | 'flatlay' | 'auto'
export type GraphicSellModelKey = 'child' | 'adult-female' | 'auto' | 'none'

export interface GraphicSellModelOption {
  key: GraphicSellModelKey
  label: string
  note: string
}
export const GRAPHIC_SELL_MODEL_OPTIONS: readonly GraphicSellModelOption[] = [
  { key: 'child', label: '儿童模特', note: '童装 / 儿童用品（参考效果即 4–6 岁儿童）' },
  { key: 'adult-female', label: '成年女模特', note: '女装 / 家居服' },
  { key: 'auto', label: '自动判断', note: '由模型按商品类型决定怎么出镜' },
  { key: 'none', label: '无人出镜', note: '只展示商品本体（平铺 / 细节）' }
]

export interface GraphicSellEffectOption {
  key: GraphicSellEffectKey
  label: string
  note: string
  /** 选中模板时套用的推荐模特（用户仍可手动改；forcedModel 为准） */
  recommendedModel: GraphicSellModelKey
  /** 选中模板时套用的推荐比例（用户仍可手动改） */
  recommendedRatio: string
  /** 由模板写死的模特类型（平铺净景 = 无人） */
  forcedModel?: GraphicSellModelKey
  /** 场景总述：每张图提示词都会带上的效果描述 */
  scene: string
  /** 有人物时按张序轮换的构图 */
  poses: readonly string[]
  /** 无人时按张序轮换的平铺构图 */
  flatPoses: readonly string[]
  /** 该模板是否必须上传商品图（要保住商品本体就必须有参考图） */
  requiresProductImage: boolean
}

export const GRAPHIC_SELL_EFFECT_OPTIONS: readonly GraphicSellEffectOption[] = [
  {
    key: 'bed-lying',
    label: '躺床俯拍',
    note: '正上方 90° 俯拍：一位模特仰卧在柔和床品上，商品由模特自然穿戴；至多一个玩偶或小猫点缀',
    recommendedModel: 'child',
    recommendedRatio: '9:16',
    requiresProductImage: true,
    scene: '参考效果：柔和床品背景的正上方 90° 垂直俯拍，画面水平、不要倾斜透视。只有一位儿童模特仰卧在床品上，商品由模特自然穿戴；床品与枕头为与商品同色系的低饱和色（商品粉色→浅粉床品，商品蓝色→雾蓝床品），有自然褶皱与柔和阴影；柔和均匀的窗光、低饱和粉彩/清透色调；画面安静、干净、有居家生活感。画面中只允许一位模特与至多一件同色系毛绒玩偶或一只小猫，不添加其它道具、发饰或人物。',
    poses: [
      '全身俯拍主图：模特仰卧居中，双臂自然放松、双腿并拢或微曲；全身与商品完整入画、双脚不裁切；眼睛轻闭、表情安静放松（像睡着一样），不看镜头、不微笑摆拍；四周留出约 8–12% 的干净空间。',
      '上半身俯拍：取景到腰胯以上，头微侧、眼睛轻闭，表情安静；重点是领口、袖型、胸前面料与版型，商品占据画面主体。',
      '面料与工艺特写（不要把画面拍成人像特写）：相机垂直俯视商品局部——绒面纹理、袖口/裤脚罗纹收口、缝线走向；可以有少量衣身覆盖，严禁人脸大特写。',
      '氛围图：保持同一床品与光线，模特安静侧卧或仰卧，画面一侧放一件毛绒玩偶或一只白色小猫；商品依然完整清晰，画面中仍然只有一位人物。'
    ],
    flatPoses: [
      '正上方 90° 垂直俯拍平铺：上衣与裤子自然摊平、版型完整，衣袖/裤腿摆开、领口朝上，画面中不出现人物。',
      '俯拍商品上半身平铺：领口、袖口、门襟与版型细节清晰；商品本身有刺绣/印花时自然呈现，没有就不要添加。',
      '面料与工艺特写：绒面纹理、罗纹收口、缝线走向，光线均匀柔和。',
      '平铺氛围：商品与一件同色系毛绒玩偶呼应，背景低饱和干净。'
    ]
  },
  {
    key: 'flatlay',
    label: '平铺净景',
    note: '无人出镜：商品平铺在干净浅色背景上，正上方 90° 目录级俯拍',
    recommendedModel: 'none',
    recommendedRatio: '3:4',
    forcedModel: 'none',
    requiresProductImage: true,
    scene: '干净浅色背景的正上方 90° 垂直俯拍平铺构图：商品自然摊平、版型完整、边缘整齐；床品/背景与商品同色系、低饱和；光线均匀柔和、有轻微自然阴影；画面干净、目录级质感、不出现人物。',
    poses: [],
    flatPoses: [
      '正上方 90° 垂直俯拍平铺：商品完整平铺在背景上，衣身/主体摆正，无折叠遮挡。',
      '俯拍商品上半身平铺：领口、袖口、门襟与版型细节清晰。',
      '面料与工艺特写：绒面纹理、罗纹收口、缝线走向。',
      '俯拍留白：商品置于画面中部，四周干净留白。'
    ]
  },
  {
    key: 'auto',
    label: 'AI 自由设计',
    note: '按文案自动设计每张图（不套用固定场景，适合非服装类商品）',
    recommendedModel: 'auto',
    recommendedRatio: '3:4',
    requiresProductImage: false,
    scene: '',
    poses: [],
    flatPoses: []
  }
]

/** 模板默认：用户上传商品图后直接出参考效果；选择会被记住（见页面预设持久化） */
export const GRAPHIC_SELL_DEFAULT_EFFECT: GraphicSellEffectKey = 'bed-lying'

export function getGraphicSellEffect(key: unknown): GraphicSellEffectOption {
  const raw = typeof key === 'string' ? key : ''
  return GRAPHIC_SELL_EFFECT_OPTIONS.find(item => item.key === raw) || GRAPHIC_SELL_EFFECT_OPTIONS[0]
}

/** 效果模板 → 推荐参数（选中模板时套用；用户仍可手动改） */
export function graphicSellEffectDefaults(key: unknown): { model: GraphicSellModelKey; ratio: string } {
  const effect = getGraphicSellEffect(key)
  return { model: effect.forcedModel || effect.recommendedModel, ratio: effect.recommendedRatio }
}

/** 模特字段归一：未知值回落到「自动判断」 */
export function normalizeSellModel(value: unknown): GraphicSellModelKey {
  return normalizeSellModelWithFallback(value, 'auto')
}

/** 模特字段归一（可指定回落值）：历史/预设里存了脏值时回落到当前效果模板的推荐模特 */
export function normalizeSellModelWithFallback(value: unknown, fallback: GraphicSellModelKey): GraphicSellModelKey {
  const raw = typeof value === 'string' ? value : ''
  return GRAPHIC_SELL_MODEL_OPTIONS.some(item => item.key === raw) ? raw as GraphicSellModelKey : fallback
}

export function sellModelLabel(value: unknown): string {
  const model = normalizeSellModel(value)
  return GRAPHIC_SELL_MODEL_OPTIONS.find(item => item.key === model)?.label || '自动判断'
}

/** 写进生图提示词的模特描述：让模型知道"谁在镜头里、怎么出镜" */
export function sellModelPrompt(value: unknown): string {
  switch (normalizeSellModel(value)) {
    case 'child':
      return '儿童模特（约 4–6 岁，自然放松、干净清爽的居家状态，不浓妆、不摆拍）'
    case 'adult-female':
      return '成年女性模特（自然居家状态，不浓妆、不过度摆拍）'
    case 'none':
      return '不出现真人模特，只展示商品本身'
    default:
      return '由模型按商品类型决定：服装请让模特自然穿上，其它商品由模特手持或使用；不适合出镜时只拍商品'
  }
}

/* ------------------------------ 效果预设持久化 ------------------------------ */

export const SELL_PRESET_STORAGE_KEY = 'shopilot.graphic-sell.preset.v1'

export interface GraphicSellPresetPrefs {
  effect: GraphicSellEffectKey
  model: GraphicSellModelKey
  ratio: string
  imageCount: number
}

/** 读预设：损坏 / 旧格式一律安全回落默认（默认即参考效果模板） */
export function parseGraphicSellPresetPrefs(raw: string | null | undefined): GraphicSellPresetPrefs {
  const fallback: GraphicSellPresetPrefs = {
    effect: GRAPHIC_SELL_DEFAULT_EFFECT,
    model: graphicSellEffectDefaults(GRAPHIC_SELL_DEFAULT_EFFECT).model,
    ratio: graphicSellEffectDefaults(GRAPHIC_SELL_DEFAULT_EFFECT).ratio,
    imageCount: SELL_COPY_DEFAULT_IMAGE_COUNT
  }
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const record = parsed as Record<string, unknown>
    const effect = getGraphicSellEffect(record.effect).key
    const defaults = graphicSellEffectDefaults(effect)
    const ratio = typeof record.ratio === 'string' && GRAPHIC_SELL_RATIO_OPTIONS.some(item => item.key === record.ratio)
      ? record.ratio
      : defaults.ratio
    return {
      effect,
      model: getGraphicSellEffect(effect).forcedModel || normalizeSellModelWithFallback(record.model, defaults.model),
      ratio,
      imageCount: clampSellCopyImageCount(record.imageCount)
    }
  } catch {
    return fallback
  }
}

export function serializeGraphicSellPresetPrefs(prefs: GraphicSellPresetPrefs): string {
  const effect = getGraphicSellEffect(prefs?.effect)
  return JSON.stringify({
    effect: effect.key,
    model: effect.forcedModel || normalizeSellModel(prefs?.model),
    ratio: GRAPHIC_SELL_RATIO_OPTIONS.some(item => item.key === prefs?.ratio) ? prefs.ratio : effect.recommendedRatio,
    imageCount: clampSellCopyImageCount(prefs?.imageCount)
  })
}

/** 平台标签：文案接口回退主文本 API 时界面要如实说明走的哪一套 */
export const SELL_COPY_CHANNEL_LABELS: Record<SellCopyChannel, string> = {
  'image-text': '生图文本 API',
  'main-text': '主文本 API 回退',
  none: '未配置'
}
export type SellCopyChannel = SellCopySource | 'none'

/* ------------------------------ 配置可用性 ------------------------------ */

/** 只要 getAiConfig 形状的子集；渲染层不依赖主进程类型，避免跨进程 import */
export interface GraphicSellConfigView {
  endpoint?: string
  resolvedEndpoint?: string
  model?: string
  hasKey?: boolean
  imageEndpoint?: string
  resolvedImageEndpoint?: string
  imageModel?: string
  hasImageKey?: boolean
  imageTextEndpoint?: string
  resolvedImageTextEndpoint?: string
  imageTextModel?: string
  hasImageTextKey?: boolean
}

export interface GraphicSellReadiness {
  /** 文案实际会走哪套配置：单独的「生图文本 API」优先，配好了主文本 API 才回退 */
  copyChannel: SellCopyChannel
  copyReady: boolean
  imageReady: boolean
  copyLabel: string
  imageLabel: string
}

/**
 * 判据与主进程 `chatCompleteForImageText` 完全同源：
 * 生图文本 API 三件套（Key / 地址 / 模型）齐了用它；否则回退主文本 API（Key / 地址 / 模型）；
 * 两套都没有就是未配置 —— 界面据此给出可执行的下一步，而不是让用户点一个注定失败的按钮。
 */
export function resolveGraphicSellReadiness(config: GraphicSellConfigView | null | undefined): GraphicSellReadiness {
  const imageTextReady = Boolean(config?.hasImageTextKey && config?.resolvedImageTextEndpoint && config?.imageTextModel)
  const mainTextReady = Boolean(config?.hasKey && config?.resolvedEndpoint && config?.model)
  const copyChannel: SellCopyChannel = imageTextReady ? 'image-text' : mainTextReady ? 'main-text' : 'none'
  return {
    copyChannel,
    copyReady: copyChannel !== 'none',
    imageReady: Boolean(config?.hasImageKey && config?.resolvedImageEndpoint && config?.imageModel),
    copyLabel: SELL_COPY_CHANNEL_LABELS[copyChannel],
    imageLabel: config?.hasImageKey ? (config?.imageModel || '已配置') : '未配置'
  }
}

/* ------------------------------ 组参 ------------------------------ */

export interface GraphicSellFormState {
  productName: string
  sellingPoints: string
  price: string
  originalPrice: string
  audience: string
  platform: string
  style: string
  imageCount: number
  images?: readonly GraphicSellMaterial[]
}

export type GraphicSellInputResult =
  | { ok: true; input: SellCopyInput }
  | { ok: false; message: string }

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 组装 `ai.generateSellCopy` 的入参：
 * · 商品名必填（AI 要据此写标题和正文；只传图不写名会导致标题全是"这款好物"）；
 * · 文本字段 trim 后为空就不传，超长按 shared 上限截断；
 * · 图片最多 3 张，非法 data URL 直接丢；用户上传了但一张都不合法时明确报错，不静默当没传。
 */
export function buildGraphicSellInput(form: GraphicSellFormState): GraphicSellInputResult {
  const productName = clip(form?.productName, SELL_COPY_LIMITS.productName)
  if (!productName) return { ok: false, message: '请先填写商品名称：AI 要用它写标题和正文。' }

  const images: SellCopyImagePayload[] = []
  for (const image of form?.images || []) {
    if (images.length >= SELL_COPY_LIMITS.maxImages) break
    const payload = dataUrlToAnalysisImage(image as AnalysisSourceImage)
    if (payload) images.push(payload)
  }
  const uploaded = Array.isArray(form?.images) ? form.images.length : 0
  if (uploaded > 0 && images.length === 0) {
    // 文案按渲染层实际白名单写：readImage 只收 PNG/JPEG、单张 ≤5MB（比 shared 契约的 8MB/webp 更严），
    // 兜底报错要和"能选进去的文件"对得上，不能照抄主进程的宽口径
    return { ok: false, message: '商品图无法识别：仅支持 PNG 或 JPEG，且单张不超过 5MB。' }
  }

  const input: SellCopyInput = {
    productName,
    platform: normalizeSellCopyPlatform(form?.platform),
    style: normalizeSellCopyStyle(form?.style),
    imageCount: clampSellCopyImageCount(form?.imageCount),
    images
  }
  const sellingPoints = clip(form?.sellingPoints, SELL_COPY_LIMITS.sellingPoints)
  const price = clip(form?.price, SELL_COPY_LIMITS.price)
  const originalPrice = clip(form?.originalPrice, SELL_COPY_LIMITS.originalPrice)
  const audience = clip(form?.audience, SELL_COPY_LIMITS.audience)
  if (sellingPoints) input.sellingPoints = sellingPoints
  if (price) input.price = price
  if (originalPrice) input.originalPrice = originalPrice
  if (audience) input.audience = audience
  return { ok: true, input }
}

/* ------------------------------ 结果清洗 ------------------------------ */

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const tag = cleanText(item, SELL_COPY_LIMITS.tag).replace(/^#+/, '').trim()
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= SELL_COPY_LIMITS.tags) break
  }
  return out
}

/**
 * 生图接口返回的单张图片 → 可渲染 URL。
 * 兼容两种真实返回：`{ b64Json, mimeType }`（转 data URL）与外部 `url`；拿不到就返回空串。
 * 放在纯模块里：主进程返回体形状不受渲染层控制，这里收口后页面不必到处断言 any。
 */
export function readGeneratedImageUrl(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const record = item as { b64Json?: unknown; mimeType?: unknown; url?: unknown }
  if (typeof record.b64Json === 'string' && record.b64Json) {
    const mimeType = typeof record.mimeType === 'string' && record.mimeType ? record.mimeType : 'image/png'
    return `data:${mimeType};base64,${record.b64Json}`
  }
  return typeof record.url === 'string' ? record.url : ''
}

/** 把主进程返回体收成可渲染的 `SellCopyResult`。
 * 主进程已经清洗过一遍；这里是渲染层边界上的最后一道：拿不到标题/正文就返回 null，
 * 页面据此显示"接口返回的文案不完整"，而不是渲染一张空白笔记卡片。
 */
export function readGraphicSellResult(data: unknown): SellCopyResult | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const title = cleanText(record.title, SELL_COPY_LIMITS.title)
  const body = cleanText(record.body, SELL_COPY_LIMITS.body)
  if (!title && !body) return null
  const source: SellCopySource = record.source === 'main-text' ? 'main-text' : 'image-text'
  return {
    title,
    body,
    tags: cleanTags(record.tags),
    coverText: cleanText(record.coverText, SELL_COPY_LIMITS.coverText),
    imagePrompts: Array.isArray(record.imagePrompts)
      ? record.imagePrompts.map(item => cleanText(item, SELL_COPY_LIMITS.imagePrompt)).filter(Boolean).slice(0, SELL_COPY_LIMITS.imageCountMax)
      : [],
    model: cleanText(record.model, 120) || '—',
    elapsedMs: Number.isFinite(Number(record.elapsedMs)) ? Math.max(0, Math.round(Number(record.elapsedMs))) : 0,
    source,
    imageCount: Number.isFinite(Number(record.imageCount)) ? Math.max(0, Math.round(Number(record.imageCount))) : 0
  }
}

/**
 * 错误话术：主进程已经本地化过的中文一律原样透传（`ai-failure-text.ts` 会把网络/超时/凭据/限流翻成可执行中文）；
 * 这里只补主进程覆盖不到的两类：未配置与空来源，避免出现"连不上 AI 接口：未配置"这种套娃。
 */
export function describeGraphicSellError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : ''
  const detail = message.replace(/^[A-Z_]+:\s*/, '').trim()
  const haystack = `${code} ${detail}`
  if (/[\u4e00-\u9fa5]/.test(detail)) return detail
  if (/AI_EMPTY_SOURCE|EMPTY_SOURCE/i.test(haystack)) return '请先填写商品名称，或上传一张商品图，再生成带货文案'
  if (/NOT_CONFIGURED|not configured/i.test(haystack)) {
    return '文案接口未配置：请到设置中心 → AI 配置 → 生图文本 API 填写地址、模型和 Key（或配置主文本 API 用于回退）'
  }
  const summary = detail.slice(0, 120)
  return summary ? `文案生成失败：${summary}` : '文案生成失败，请稍后重试'
}

/* ------------------------------ 生图提示词 ------------------------------ */

/** 效果模板上下文：页面选择交给提示词组装，纯函数保持可测 */
export interface GraphicSellEffectContext {
  effect: GraphicSellEffectKey
  model: GraphicSellModelKey
}
export const GRAPHIC_SELL_AUTO_EFFECT_CONTEXT: GraphicSellEffectContext = { effect: 'auto', model: 'auto' }

/**
 * 商品一致性约束（所有模板共用）：没有它，"生成同款效果"会变成"长得像的另一件商品"。
 * 文字条款刻意写成**条件式**：2026-10-19 实测生成图出现 `D' laudi` 之类假英文——
 * 商品图里本来没有字，但旧提示词说"保持刺绣文字不变"，模型就自己编了字。
 */
const PRODUCT_FIDELITY_CLAUSE = '商品一致性（最高优先级）：严格保持上传商品参考图里的商品本体——颜色（色相/明度）、面料质感（摇粒绒/法兰绒绒面）、图案、领口/袖口/裤脚、版型比例都不变；不得改变款式，也不得添加参考图里没有的图案。如果参考图是平铺商品图，请让模特穿上该商品（服装类）。商品上的文字/logo 只在参考图确实有时才原样保留；参考图没有文字时，画面里不要出现任何文字或字母，更不要编造品牌名。'

/**
 * 真实感条款：实测旧提示词下模型默认输出"磨皮娃娃脸 + 睁眼微笑看镜头"的影楼写真，
 * 与参考效果的"闭眼安睡、居家柔软"完全相反。这里把摄影质感与人物状态写死。
 */
const PHOTO_REALISM_CLAUSE = '真实感与画质：真实商业摄影，自然柔和的窗光与均匀光线，避免过曝和强烈阴影；儿童皮肤与头发保留自然细节，不要过度磨皮、娃娃脸、塑料感或美颜滤镜；人物表情安静自然，不要摆拍式微笑、不要盯着镜头；手部/脚部自然、完整不裁切、不畸形；画面清晰、商品细节可辨。'

/** 禁止编造条款：实测出现"第二个孩子 + 两套不同颜色商品 + 多件道具"，与参考效果不符 */
const NO_INVENTION_CLAUSE = '禁止编造：画面里只出现一位人物与一套商品；不添加参考商品图里没有的配饰、发饰、帽子、花朵、花纹床品或额外道具；不要出现任何字母、乱码文字、假品牌、水印、价格标签、平台标识或其它人物。'

/**
 * 逐图提示词。
 *
 * auto：沿用"文案模型给的逐图画面描述"（原行为），只补用途/比例/留白与禁止项；
 * 效果模板：场景、模特、按张序轮换的构图都来自模板（保证一套图是同一种效果），
 * 文案里的画面描述不再参与，避免与模板场景冲突导致每张图风格跑偏。
 */
export function buildGraphicSellImagePrompt(
  input: SellCopyInput,
  result: SellCopyResult,
  index: number,
  ratioLabel = '3:4',
  context: GraphicSellEffectContext = GRAPHIC_SELL_AUTO_EFFECT_CONTEXT
): string {
  const total = clampSellCopyImageCount(input.imageCount)
  const seq = Math.min(total, Math.max(1, index + 1))
  const effect = getGraphicSellEffect(context?.effect)
  const model = effect.forcedModel || normalizeSellModel(context?.model)
  const base = [
    `电商图文带货笔记配图（第 ${seq}/${total} 张，${ratioLabel}）：`,
    `商品：${input.productName || '以参考图为准'}${input.price ? `，售价 ${input.price}` : ''}`,
    input.sellingPoints ? `卖点：${input.sellingPoints}` : '',
    `平台/风格：${normalizeSellCopyPlatform(input.platform)} / ${normalizeSellCopyStyle(input.style)}`
  ]

  if (effect.key === 'auto') {
    const scene = cleanText(result.imagePrompts[index], SELL_COPY_LIMITS.imagePrompt)
      || `围绕「${input.productName || '商品'}」的日常使用场景与细节特写`
    const coverHint = seq === 1 && result.coverText
      ? `封面图：为标题大字「${result.coverText}」预留干净的排版留白`
      : ''
    return [
      ...base,
      coverHint,
      `画面：${scene}`,
      PRODUCT_FIDELITY_CLAUSE,
      PHOTO_REALISM_CLAUSE,
      '文字要求：画面内不要生成任何文字、数字、价格标签、水印或品牌标识；若文案需要标题，只留干净的排版留白。'
    ].filter(Boolean).join('\n')
  }

  const poses = model === 'none' ? effect.flatPoses : effect.poses
  const shot = poses.length ? poses[index % poses.length] : ''
  return [
    ...base,
    `效果模板：${effect.label}。${effect.scene}`,
    `出镜模特：${sellModelPrompt(model)}`,
    shot ? `本张构图：${shot}` : '',
    PRODUCT_FIDELITY_CLAUSE,
    PHOTO_REALISM_CLAUSE,
    NO_INVENTION_CLAUSE,
    '画面要求：正上方俯拍视角稳定（不要倾斜、不要夸张透视）；商品占画面主体、细节清晰；床品/背景与商品同色系、低饱和、有自然褶皱与轻阴影；四周保留自然留白，不要把人体关节或商品裁到画外。'
  ].filter(Boolean).join('\n')
}

/* ------------------------------ 文案编辑与复制 ------------------------------ */

/** 编辑区输入的话题标签 → 清洗后的数组（支持 #、逗号、顿号、空白分隔） */
export function parseGraphicSellTags(raw: string): string[] {
  if (typeof raw !== 'string') return []
  const out: string[] = []
  for (const piece of raw.split(/[\s,，、#;；]+/)) {
    const tag = piece.trim().slice(0, SELL_COPY_LIMITS.tag)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= SELL_COPY_LIMITS.tags) break
  }
  return out
}

/** 一键复制全文：标题 + 正文 + #话题（与用户在小红书/抖音里看到的粘贴结果一致） */
export function graphicSellFullText(title: string, body: string, tags: readonly string[]): string {
  const heading = clip(title, SELL_COPY_LIMITS.title)
  const text = clip(body, SELL_COPY_LIMITS.body)
  const tagLine = (tags || [])
    .map(tag => cleanText(tag, SELL_COPY_LIMITS.tag).replace(/^#+/, ''))
    .filter(Boolean)
    .map(tag => `#${tag}`)
    .join(' ')
  return [heading, text, tagLine].filter(Boolean).join('\n\n')
}

/**
 * 效果模板模式下"一张图一次请求"：提示词里的构图（正面/侧身/近景/氛围）是按张序轮换的，
 * 一次 n=4 会让四张图共用同一段构图描述。AI 自由设计仍按单次最多 4 张批量发，省请求。
 */
export function graphicSellImageBatchSize(effectKey: unknown): number {
  return getGraphicSellEffect(effectKey).key === 'auto' ? 4 : 1
}

/** 图片张数 → 每次请求的张数（单次最多 4 张；5–9 张拆多请求，不能少发） */
export function graphicSellImageBatches(count: number, batchSize = 4): number[] {
  const total = clampSellCopyImageCount(count)
  const perRequest = Math.min(4, Math.max(1, Math.round(Number(batchSize) || 1)))
  const batches: number[] = []
  for (let remaining = total; remaining > 0; remaining -= perRequest) batches.push(Math.min(perRequest, remaining))
  return batches
}

/* ------------------------------ 历史会话（localStorage） ------------------------------ */

export const SELL_HISTORY_STORAGE_KEY = 'shopilot.graphic-sell.history.v1'
/** 条目里是 base64 data URL（数 MB/张），不设预算几乎必然击穿 localStorage 约 5MB 的配额。 */
export const SELL_HISTORY_STORAGE_BUDGET = 4 * 1024 * 1024
export const SELL_HISTORY_MAX_SESSIONS = 30

export interface GraphicSellHistoryImage {
  url: string
  index: number
}

export interface GraphicSellHistorySession {
  id: string
  createdAt: number
  productName: string
  platform: string
  style: string
  ratio: string
  /** 效果模板与出镜模特（旧记录没有这两个字段时按参考效果模板恢复） */
  effect?: GraphicSellEffectKey
  sellModel?: GraphicSellModelKey
  title: string
  body: string
  tags: string[]
  coverText: string
  imagePrompts: string[]
  images: GraphicSellHistoryImage[]
  /** 文案模型名（注意：不是出镜模特） */
  model: string
  /** 文案实际走的配置通道（与 SellCopyResult.source 同源；旧记录没有该字段时恢复时缺省 image-text） */
  source?: SellCopySource
}

/** 估算一条历史会话占用的字符数（JSON 落盘前做预算裁剪用，不必精确到字节） */
function historySessionBytes(session: GraphicSellHistorySession): { text: number; images: number } {
  const text = JSON.stringify({
    id: session.id,
    createdAt: session.createdAt,
    productName: session.productName,
    platform: session.platform,
    style: session.style,
    ratio: session.ratio,
    effect: session.effect,
    sellModel: session.sellModel,
    title: session.title,
    body: session.body,
    tags: session.tags,
    coverText: session.coverText,
    imagePrompts: session.imagePrompts,
    source: session.source,
    model: session.model
  }).length
  const images = (session.images || []).reduce((total, image) => total + (typeof image?.url === 'string' ? image.url.length + 32 : 32), 0)
  return { text, images }
}

/**
 * 按字节预算从新到旧保留会话。
 * 单条会话的配图可能就超过预算（一张 base64 图 2–4MB）：这时**保留文案、丢掉配图**，
 * 而不是把整条历史扔了——用户至少还能恢复标题/正文/标签，再重新生成配图。
 */
export function trimGraphicSellHistory(
  sessions: readonly GraphicSellHistorySession[],
  budget: number = SELL_HISTORY_STORAGE_BUDGET,
  maxSessions: number = SELL_HISTORY_MAX_SESSIONS
): GraphicSellHistorySession[] {
  const out: GraphicSellHistorySession[] = []
  let used = 0
  for (const session of (sessions || []).slice(0, Math.max(1, maxSessions))) {
    const size = historySessionBytes(session)
    const fullBytes = size.text + size.images
    if (used + fullBytes <= budget) {
      out.push(session)
      used += fullBytes
      continue
    }
    if (used + size.text > budget) continue
    out.push({ ...session, images: [] })
    used += size.text
  }
  return out
}

/** 落盘：v1 信封（后续加字段不需要迁移裸数组） */
export function serializeGraphicSellHistory(sessions: readonly GraphicSellHistorySession[]): string {
  return JSON.stringify({ version: 1, sessions: trimGraphicSellHistory(sessions) })
}

function cleanHistorySession(raw: unknown): GraphicSellHistorySession | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const title = cleanText(record.title, SELL_COPY_LIMITS.title)
  const body = cleanText(record.body, SELL_COPY_LIMITS.body)
  if (!title && !body) return null
  const id = cleanText(record.id, 80) || `sell-${Number(record.createdAt) || 0}`
  const effect = getGraphicSellEffect(record.effect)
  const effectDefaults = graphicSellEffectDefaults(effect.key)
  return {
    id,
    createdAt: Number.isFinite(Number(record.createdAt)) ? Math.max(0, Math.round(Number(record.createdAt))) : 0,
    productName: cleanText(record.productName, SELL_COPY_LIMITS.productName),
    platform: normalizeSellCopyPlatform(record.platform),
    style: normalizeSellCopyStyle(record.style),
    ratio: cleanText(record.ratio, 8) || effectDefaults.ratio,
    effect: effect.key,
    sellModel: effect.forcedModel || normalizeSellModelWithFallback(record.sellModel, effectDefaults.model),
    title,
    body,
    tags: cleanTags(record.tags),
    coverText: cleanText(record.coverText, SELL_COPY_LIMITS.coverText),
    imagePrompts: Array.isArray(record.imagePrompts)
      ? record.imagePrompts.map(item => cleanText(item, SELL_COPY_LIMITS.imagePrompt)).filter(Boolean).slice(0, SELL_COPY_LIMITS.imageCountMax)
      : [],
    images: Array.isArray(record.images)
      ? record.images
        .filter((image): image is Record<string, unknown> => Boolean(image && typeof image === 'object'))
        .map((image, index) => ({ url: typeof image.url === 'string' ? image.url : '', index: Number.isFinite(Number(image.index)) ? Math.max(0, Math.round(Number(image.index))) : index }))
        .filter(image => image.url)
        .slice(0, SELL_COPY_LIMITS.imageCountMax)
      : [],
    model: cleanText(record.model, 120) || '—',
    // 旧记录没有 source 字段时保持 undefined，恢复时按 image-text 缺省
    source: record.source === 'main-text' || record.source === 'image-text' ? record.source : undefined
  }
}

/** 读历史：损坏/旧格式一律安全回落为空数组，不能因为一条坏数据让整页打不开 */
export function parseGraphicSellHistory(raw: string | null | undefined): GraphicSellHistorySession[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : []
    return list
      .map(cleanHistorySession)
      .filter((session): session is GraphicSellHistorySession => Boolean(session))
      .slice(0, SELL_HISTORY_MAX_SESSIONS)
  } catch {
    return []
  }
}

/** 与 image-studio-ratios 的请求尺寸表保持同一套映射（3:4 → 1024x1536 等） */
export function graphicSellRequestSize(ratio: string): '1024x1024' | '1536x1024' | '1024x1536' {
  if (ratio === '1:1') return '1024x1024'
  if (ratio === '4:3') return '1536x1024'
  return '1024x1536'
}

/** 页面默认值集中在这里：表单初值、默认比例与默认张数只此一份 */
export const GRAPHIC_SELL_DEFAULTS = {
  platform: '通用',
  style: '种草分享',
  /** 默认套用参考效果模板（俯拍躺床 9:16），与用户提供的 4 张效果图一致 */
  effect: GRAPHIC_SELL_DEFAULT_EFFECT,
  model: graphicSellEffectDefaults(GRAPHIC_SELL_DEFAULT_EFFECT).model,
  ratio: graphicSellEffectDefaults(GRAPHIC_SELL_DEFAULT_EFFECT).ratio,
  imageCount: SELL_COPY_DEFAULT_IMAGE_COUNT
} as const
