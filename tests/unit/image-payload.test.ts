import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_IMAGE_BYTES,
  dataUrlToImagePayload
} from '../../apps/desktop/src/renderer/src/features/workbench/image-payload'

/**
 * 图片 data URL 收口的回归网（2026-11-15 从已删除的商品分析模块中保留）。
 *
 * 图文带货的文案与生图请求都经过这里：只收白名单 data URL、超限丢弃。
 * 页面只负责取状态/发请求，真正的判据都在这里钉死。
 */

const SOURCE = readFileSync(
  resolve('apps/desktop/src/renderer/src/features/workbench/image-payload.ts'),
  'utf8'
)

/** 造一张合法的 data URL：payload 长度可控，便于测边界 */
function png(payload = 'AAAA', mime = 'png'): string {
  return `data:image/${mime};base64,${payload}`
}

describe('dataUrlToImagePayload：只收白名单 data URL', () => {
  it('png / jpeg / webp 都能解析出 mimeType 与 b64Json', () => {
    expect(dataUrlToImagePayload({ dataUrl: png('QUJD', 'png') })).toEqual({ mimeType: 'image/png', b64Json: 'QUJD' })
    expect(dataUrlToImagePayload({ dataUrl: png('QUJD', 'jpeg') })).toEqual({ mimeType: 'image/jpeg', b64Json: 'QUJD' })
    expect(dataUrlToImagePayload({ dataUrl: png('QUJD', 'webp') })).toEqual({ mimeType: 'image/webp', b64Json: 'QUJD' })
  })

  it('大小写与首尾空白不影响解析，mimeType 统一小写', () => {
    expect(dataUrlToImagePayload({ dataUrl: `  DATA:IMAGE/PNG;BASE64,QUJD  ` })).toEqual({ mimeType: 'image/png', b64Json: 'QUJD' })
    expect(dataUrlToImagePayload({ dataUrl: png('QUJD', 'JPEG') })).toEqual({ mimeType: 'image/jpeg', b64Json: 'QUJD' })
  })

  it('base64 的 + / = 是合法字符，不做二次解码', () => {
    expect(dataUrlToImagePayload({ dataUrl: png('a+b/c==') })).toEqual({ mimeType: 'image/png', b64Json: 'a+b/c==' })
  })

  it('非白名单类型 / 非 base64 / 不是 data URL 一律 null', () => {
    const bad = [
      'data:image/gif;base64,QUJD',
      'data:image/jpg;base64,QUJD',
      'data:image/svg+xml;base64,QUJD',
      'data:application/octet-stream;base64,QUJD',
      'data:image/png,QUJD',
      'data:image/png;base64',
      'data:image/png;base64,',
      'data:image/png;base64,QU JD',
      'data:image/png;base64,QU-JD',
      'https://example.com/a.png',
      'QUJD',
      'data:image/png;base64,%%%'
    ]
    for (const dataUrl of bad) {
      expect(dataUrlToImagePayload({ dataUrl }), `应当拒绝：${dataUrl}`).toBeNull()
    }
  })

  it('缺字段 / 空对象 / undefined 都安全返回 null', () => {
    expect(dataUrlToImagePayload({})).toBeNull()
    expect(dataUrlToImagePayload({ name: 'a.png' })).toBeNull()
    expect(dataUrlToImagePayload({ dataUrl: undefined })).toBeNull()
    expect(dataUrlToImagePayload({ dataUrl: '' })).toBeNull()
    expect(dataUrlToImagePayload({ dataUrl: '   ' })).toBeNull()
    expect(dataUrlToImagePayload(null as never)).toBeNull()
    expect(dataUrlToImagePayload(undefined as never)).toBeNull()
    // mimeType 字段单独存在不算数：判据是 dataUrl 前缀
    expect(dataUrlToImagePayload({ mimeType: 'image/png' })).toBeNull()
  })

  it('超过 8MB 的图返回 null，刚好 8MB 仍可用', () => {
    // ceil(len * 3 / 4) 与主进程生图收口的估算方式一致
    const atLimit = 'A'.repeat(Math.floor(MAX_IMAGE_BYTES * 4 / 3))
    expect(dataUrlToImagePayload({ dataUrl: png(atLimit) })).not.toBeNull()
    const overLimit = 'A'.repeat(Math.floor(MAX_IMAGE_BYTES * 4 / 3) + 1)
    expect(dataUrlToImagePayload({ dataUrl: png(overLimit) })).toBeNull()
  })
})

describe('模块边界与常量', () => {
  it('是纯模块：不依赖 vue / electron / DOM / node', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]vue['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]node:/)
    expect(SOURCE).not.toMatch(/require\(/)
    expect(SOURCE).not.toMatch(/\bdocument\./)
    expect(SOURCE).not.toMatch(/\bwindow\./)
  })

  it('单张上限与主进程口径一致', () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024)
  })
})
