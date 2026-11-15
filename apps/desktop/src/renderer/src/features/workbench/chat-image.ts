/**
 * 「对话生图」的纯规则（2026-11-14）。
 *
 * 不接文本模型：用户的每条消息本身就是生图提示词；选择「基于这张改」时，把上一张图
 * 作为 sourceImages 交给生图接口，对话上下文由消息列表与参考图承担。这样不会多一套
 * 文本 API 失败面，也不会把对话历史悄悄发给另一个供应商。
 */
export const CHAT_IMAGE_RATIO_OPTIONS = [
  { key: '1:1', label: '1 : 1 方图' },
  { key: '3:4', label: '3 : 4 竖图' },
  { key: '4:3', label: '4 : 3 横图' }
] as const

export type ChatImageRatio = typeof CHAT_IMAGE_RATIO_OPTIONS[number]['key']

export const CHAT_IMAGE_COUNT_OPTIONS = [1, 2, 4] as const

/** 与商品图工作台同口径：上传参考图单张最大 5MB */
export const CHAT_IMAGE_MAX_REFERENCE_BYTES = 5 * 1024 * 1024

/** 生图接口只接受这三种尺寸 */
export function chatImageRequestSize(ratio: string): '1024x1024' | '1536x1024' | '1024x1536' {
  if (ratio === '4:3') return '1536x1024'
  if (ratio === '1:1') return '1024x1024'
  return '1024x1536'
}

export function clampChatImageCount(value: unknown): number {
  const numeric = Math.round(Number(value) || 1)
  return Math.min(4, Math.max(1, numeric))
}

/** 有参考图时明确「只改指定部分」，避免模型把整张图重画导致主体丢失 */
export function buildChatImagePrompt(text: string, hasReference: boolean): string {
  const instruction = String(text || '').trim()
  if (!instruction) return ''
  const common = '输出一张主体清晰、光线自然、可直接用于电商场景的图片；不要添加水印、logo、品牌标识或用户没有要求的文字。'
  if (!hasReference) return `${instruction}。${common}`
  return `基于参考图修改：${instruction}。保持参考图中未被要求修改的主体、颜色、材质与构图一致，只修改用户指定的部分。${common}`
}

export interface ChatImageSource {
  name: string
  mimeType: string
  b64Json: string
}

/** data URL → 生图接口的 sourceImages 结构；不是图片 data URL 时返回 null（不伪造） */
export function chatImageSourceFromDataUrl(dataUrl: string, name = 'reference.png'): ChatImageSource | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''))
  if (!match) return null
  return { name, mimeType: match[1].toLowerCase(), b64Json: match[2] }
}

export function chatImageSaveName(index: number, now = Date.now()): string {
  return `chat-image-${now}-${Math.max(1, Math.round(index))}.png`
}
