/**
 * 图片本地化的安全规则（方案 §5.9）
 *
 * 为什么单独一份且放在 shared：`remote_url` 是**从平台页面读来的不可信输入**，
 * 这几条判定是安全边界，必须能被单测直接覆盖 —— 放在主进程里就只能靠真机去试。
 *
 * 覆盖的威胁（都来自"URL 由页面提供"这个前提）：
 *   · **SSRF**：URL 指向内网/环回/链路本地 → 拒绝（否则等于给页面一个探测内网的代理）；
 *   · **路径穿越**：落盘路径**只由 sha256 生成**，与 URL 无关（见 `mediaRelativePath`）；
 *   · **超大文件**：单张上限（Content-Length 与流式计数双保险）；
 *   · **格式伪装**：按 **magic bytes** 判真实类型，只接受 jpg/png/webp/gif；
 *   · **SVG**：**明确拒绝**（可内嵌脚本，而这个应用会渲染这些图）。
 */

/** 单张图片上限：10MB（方案 §5.9）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 重定向最多 3 跳，且**每一跳都要重新校验**（否则可以用 302 绕过首次校验）。 */
export const MAX_IMAGE_REDIRECTS = 3
/** 单张总超时。 */
export const IMAGE_FETCH_TIMEOUT_MS = 20_000
/** 尺寸上限（只读头部拿尺寸，不整体解码）。 */
export const MAX_IMAGE_DIMENSION = 10_000

export type ImageBlockReason =
  | 'bad_scheme'
  | 'private_address'
  | 'too_large'
  | 'unsupported_type'
  | 'svg_rejected'
  | 'too_many_redirects'
  | 'timeout'
  | 'http_error'
  | 'empty_body'

/** 允许的图片类型（magic bytes → mime + 扩展名）。 */
export const ALLOWED_IMAGE_TYPES: ReadonlyArray<{ mime: string; ext: string; match: (bytes: Uint8Array) => boolean }> = [
  {
    mime: 'image/jpeg', ext: 'jpg',
    match: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  {
    mime: 'image/png', ext: 'png',
    match: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  },
  {
    mime: 'image/webp', ext: 'webp',
    // RIFF....WEBP
    match: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  },
  {
    mime: 'image/gif', ext: 'gif',
    match: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
  }
]

/** 只允许 http/https（`file:` / `data:` / `javascript:` 一律拒）。 */
export function isAllowedImageScheme(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 主机名是不是私网/环回/链路本地/保留地址。
 *
 * 处理三类写法：
 *   ① IPv4 字面量（含 `127.0.0.1`、`10.x`、`172.16-31.x`、`192.168.x`、`169.254.x`、`0.0.0.0`）；
 *   ② IPv6 字面量（`::1`、`fc00::/7` ULA、`fe80::/10` 链路本地、`::ffff:x.x.x.x` 映射）；
 *   ③ 本机名（`localhost` 及 `*.localhost`、`*.local`）。
 *
 * 域名解析后的真实 IP **不在这里判**（那需要 DNS，且会引入 TOCTOU）—— 主进程在拿到响应后
 * 还会用 `response.url` 的最终主机名再判一次，见 product-media-service 的说明。
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  // IPv6
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    // IPv4 映射：::ffff:127.0.0.1
    const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return isPrivateAddress(mapped[1])
    const first = parseInt(host.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true   // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return true   // fe80::/10 链路本地
    if ((first & 0xff00) === 0xff00) return true   // ff00::/8 组播
    return false
  }

  // IPv4
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false   // 域名，交给上层按最终主机再判
  const [a, b] = parts.map(Number)
  if (parts.map(Number).some(value => value > 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true                 // 链路本地（云元数据 169.254.169.254 就在这）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true       // 运营商级 NAT
  if (a >= 224) return true                               // 组播/保留
  return false
}

/** 按 magic bytes 判真实类型；认不出来（含 SVG/HTML/文本）返回 null。 */
export function detectImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  for (const type of ALLOWED_IMAGE_TYPES) {
    if (type.match(bytes)) return { mime: type.mime, ext: type.ext }
  }
  return null
}

/** 看起来是不是 SVG/XML（用于给出更准确的拒绝原因，而不是笼统的"类型不支持"）。 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).toLowerCase()
  return head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))
}

/**
 * 落盘相对路径：`<sha256 前 2 位>/<sha256>.<ext>`。
 *
 * **只由 sha256 与类型生成**，不含任何来自 URL 的字符 —— 路径穿越在这里被结构性地排除，
 * 而不是靠"过滤 ../"这种容易漏的做法。
 */
export function mediaRelativePath(sha256: string, ext: string): string {
  const clean = String(sha256 || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('INVALID_SHA256')
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin'
  return `${clean.slice(0, 2)}/${clean}.${safeExt}`
}

/** 内容长度是否超限（Content-Length 预检用）。 */
export function exceedsSizeLimit(bytes: number, limit = MAX_IMAGE_BYTES): boolean {
  return !Number.isFinite(bytes) || bytes > limit
}
