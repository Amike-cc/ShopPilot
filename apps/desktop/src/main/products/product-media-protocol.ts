/**
 * 商品图片只读协议（v4 重设计 §4.7）：`shopilot-media://local/<相对路径>` → `userData/product-media/<相对路径>`。
 *
 * 为什么需要它：列表要显示商品主图缩略图，而图片是本地文件；用 base64 data URL 会
 * 把几十行 × 每行几百 KB 灌进渲染进程。自定义协议零拷贝、可被浏览器缓存。
 *
 * 三层校验（都不可省）：
 *   1. host 只认 `local`（URL 里不带任何目录语义）；
 *   2. 路径规范化后必须仍在 mediaRoot 之内（防 `../` 穿越）；
 *   3. 扩展名白名单（只服务图片，不服务任意文件）。
 * 任何一层不过 → 404（如实拒绝，不抛异常到渲染层）。
 */

import { app, protocol } from 'electron'
import { readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'

export const PRODUCT_MEDIA_SCHEME = 'shopilot-media'

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 必须在 app ready **之前**调用（scheme 权限登记；漏了它 <img> 仍可用，但拿不到标准 URL 语义）。 */
export function registerProductMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PRODUCT_MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ])
}

/** app ready 之后调用：挂上真正的 handler。 */
export function registerProductMediaProtocol(): void {
  const mediaRoot = join(app.getPath('userData'), 'product-media')
  const rootWithSep = mediaRoot.endsWith(sep) ? mediaRoot : mediaRoot + sep

  protocol.handle(PRODUCT_MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'local') return new Response('not found', { status: 404 })
      const rel = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '')
      const absolute = resolve(mediaRoot, rel)
      if (absolute !== mediaRoot && !absolute.startsWith(rootWithSep)) return new Response('not found', { status: 404 })
      const ext = extname(absolute).toLowerCase()
      if (!ALLOWED_EXT.has(ext)) return new Response('not found', { status: 404 })
      const data = await readFile(absolute)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
          // 文件名是 sha256 → 内容寻址，可放心长缓存
          'cache-control': 'max-age=86400'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
