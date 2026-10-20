/**
 * 图文带货（AI 创作 → 图文带货工作台）的跨进程契约 —— 2026-10-19
 *
 * 为什么单独一份 shared 文件：这个功能横跨两个进程、两个模型接口——
 *   ① 主进程用「生图文本 API」生成带货笔记文案（标题 / 正文 / 话题 / 封面文案 / 逐图画面描述），
 *      提示词与 JSON 解析全部留在主进程（Renderer 不能注入任意 system 指令）；
 *   ② 渲染层拿到结构化文案后，再按「逐图画面描述」调用生图接口出配图。
 * 两端都要用同一套字段名、白名单与长度上限，写死在任何一侧都会在另一侧悄悄漂移。
 *
 * 边界：真实请求、Key、超时、审计都在主进程；这里只放纯常量与类型，不 import electron / vue。
 */

/** 可选的发布平台（“通用”= 不按某个平台的版式语言写文案） */
export const SELL_COPY_PLATFORMS = ['通用', '小红书', '抖音', '快手', '视频号'] as const
export type SellCopyPlatform = typeof SELL_COPY_PLATFORMS[number]

/** 图文风格：与工作台左侧「笔记风格」下拉一一对应 */
export const SELL_COPY_STYLES = ['种草分享', '测评对比', '生活方式', '使用教程', '促销爆款'] as const
export type SellCopyStyle = typeof SELL_COPY_STYLES[number]

export const SELL_COPY_DEFAULT_PLATFORM: SellCopyPlatform = '通用'
export const SELL_COPY_DEFAULT_STYLE: SellCopyStyle = '种草分享'
export const SELL_COPY_DEFAULT_IMAGE_COUNT = 4

/**
 * 输入/输出上限。
 *
 * 与主进程 handler 的清洗口径一致：超长内容在进模型前就截断，不让用户因为多写两行字
 * 收到一个“请求失败”。图片上限与现有「AI 生成商品图」页面的商品分析保持一致
 * （最多 3 张、单张 ≤ 8MB、png/jpeg/webp）。
 */
export const SELL_COPY_LIMITS = {
  productName: 120,
  sellingPoints: 500,
  price: 24,
  originalPrice: 24,
  audience: 120,
  imageCountMin: 1,
  imageCountMax: 9,
  maxImages: 3,
  maxImageBytes: 8 * 1024 * 1024,
  title: 40,
  body: 1200,
  coverText: 20,
  tag: 20,
  tags: 8,
  imagePrompt: 200
} as const

/** 图片 MIME 白名单（与主进程 handler、生图文本分析共用同一集合） */
export const SELL_COPY_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type SellCopyImageMimeType = typeof SELL_COPY_IMAGE_MIME_TYPES[number]

/** 渲染层 → 主进程的图片载荷：只传 data URL 解出来的 MIME 与 base64，不传本地路径。 */
export interface SellCopyImagePayload {
  mimeType: string
  b64Json: string
}

/**
 * 渲染层 → 主进程：只传受限结构化字段。
 * 不传 system / prompt 原文 —— 提示词由主进程组装（防止渲染层注入任意指令）。
 */
export interface SellCopyInput {
  productName?: string
  sellingPoints?: string
  price?: string
  originalPrice?: string
  /** 目标人群/使用场景，选填 */
  audience?: string
  platform?: string
  style?: string
  /** 期望配图张数（1–9），同时决定 imagePrompts 的条数 */
  imageCount?: number
  images?: SellCopyImagePayload[]
}

/** 这次文案实际走的配置：单独的「生图文本 API」或回退主文本 API（界面如实显示） */
export type SellCopySource = 'image-text' | 'main-text'

/** 主进程 → 渲染层：已清洗、可直接展示/编辑/复制并用于生图的带货笔记。 */
export interface SellCopyResult {
  /** 笔记标题（≤ 40 字，不含话题标签） */
  title: string
  /** 笔记正文（可含换行；≤ 1200 字） */
  body: string
  /** 话题标签，**不带 # 前缀**（界面统一补 #，方便用户二次编辑） */
  tags: string[]
  /** 封面大字/首图贴纸文案（≤ 20 字） */
  coverText: string
  /** 逐图画面描述，长度 = 请求的 imageCount（渲染层据此逐张生图） */
  imagePrompts: string[]
  model: string
  elapsedMs: number
  source: SellCopySource
  /** 本次真正读图的张数（0 = 没读图，纯文本生成） */
  imageCount: number
}

/** 平台字段归一：未知值回落到「通用」，不因为前端传了脏值就整单失败。 */
export function normalizeSellCopyPlatform(value: unknown): SellCopyPlatform {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (SELL_COPY_PLATFORMS as readonly string[]).includes(raw) ? raw as SellCopyPlatform : SELL_COPY_DEFAULT_PLATFORM
}

/** 风格字段归一：未知值回落到「种草分享」。 */
export function normalizeSellCopyStyle(value: unknown): SellCopyStyle {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (SELL_COPY_STYLES as readonly string[]).includes(raw) ? raw as SellCopyStyle : SELL_COPY_DEFAULT_STYLE
}

/** 配图张数归一：非数字 / 小数 / 越界都夹到 1–9，避免渲染层拿脏值拼出空请求。 */
export function clampSellCopyImageCount(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return SELL_COPY_DEFAULT_IMAGE_COUNT
  return Math.min(SELL_COPY_LIMITS.imageCountMax, Math.max(SELL_COPY_LIMITS.imageCountMin, Math.round(num)))
}
