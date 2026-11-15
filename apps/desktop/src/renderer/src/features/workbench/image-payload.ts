/**
 * 图片 data URL 收口（纯逻辑，零 vue / electron / DOM）
 *
 * 图文带货把素材图交给主进程前统一成 `{ mimeType, b64Json }`：
 * 只认 png / jpeg / webp 的 base64 data URL，单张 ≤ 8MB；
 * 拿不到合法数据一律返回 null，由调用方丢弃，不做占位。
 */

/** 单张图片字节上限（与主进程生图/文案收口一致） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface ImageSource {
  name?: string
  dataUrl?: string
  /** 调用方已知的 MIME；真正的判据仍是 dataUrl 前缀（拿不到就返回 null） */
  mimeType?: string
}

export interface ImagePayload {
  mimeType: string
  b64Json: string
}

/** 只认这几种 data URL：`data:image/png|jpeg|webp;base64,<payload>` */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i

/**
 * data URL → 主进程要的 `{ mimeType, b64Json }`。
 * 拿不到合法数据（缺字段 / 不是白名单类型 / 不是 base64 / 超 8MB）一律返回 null。
 */
export function dataUrlToImagePayload(source: ImageSource): ImagePayload | null {
  const dataUrl = typeof source?.dataUrl === 'string' ? source.dataUrl.trim() : ''
  const match = IMAGE_DATA_URL.exec(dataUrl)
  if (!match) return null
  const b64Json = match[2]
  // 与主进程相同的估算方式：base64 长度 × 3/4
  if (Math.ceil(b64Json.length * 3 / 4) > MAX_IMAGE_BYTES) return null
  return { mimeType: `image/${match[1].toLowerCase()}`, b64Json }
}
