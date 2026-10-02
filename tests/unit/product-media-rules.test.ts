import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  detectImageType,
  exceedsSizeLimit,
  isAllowedImageScheme,
  isPrivateAddress,
  looksLikeSvg,
  mediaRelativePath
} from '../../packages/shared/src/product-media-rules'

/** 造一段带正确 magic bytes 的假图片内容。 */
function bytes(...values: number[]): Uint8Array { return new Uint8Array(values) }

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00)
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50)

describe('图片本地化安全：SSRF 判定（URL 来自页面，是不可信输入）', () => {
  it('私网 / 环回 / 链路本地 / 保留地址一律拒绝', () => {
    for (const host of [
      '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254',      // 云元数据服务，最经典的 SSRF 目标
      '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
      'localhost', 'foo.localhost', 'printer.local'
    ]) {
      expect(isPrivateAddress(host), host).toBe(true)
    }
  })

  it('IPv6 的环回 / ULA / 链路本地 / IPv4 映射都要挡住', () => {
    for (const host of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1']) {
      expect(isPrivateAddress(host), host).toBe(true)
    }
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('正常公网 IP 与域名不拦（域名交给"响应最终主机名"再判一次）', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', 'mmec.wxqcloud.qq.com.cn', 'p9-aio.ecombdimg.com']) {
      expect(isPrivateAddress(host), host).toBe(false)
    }
    expect(isPrivateAddress('')).toBe(true)   // 空主机名按不安全处理
  })

  it('只允许 http/https（file: / data: / javascript: 全拒）', () => {
    expect(isAllowedImageScheme('https://a/1.jpg')).toBe(true)
    expect(isAllowedImageScheme('http://a/1.jpg')).toBe(true)
    for (const url of ['file:///C:/Windows/win.ini', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'ftp://a/1.jpg', '不是URL']) {
      expect(isAllowedImageScheme(url), url).toBe(false)
    }
  })
})

describe('图片本地化安全：按 magic bytes 判类型，SVG 明确拒绝', () => {
  it('四种允许的类型都能认出来', () => {
    expect(detectImageType(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(detectImageType(PNG)).toEqual({ mime: 'image/png', ext: 'png' })
    expect(detectImageType(GIF)).toEqual({ mime: 'image/gif', ext: 'gif' })
    expect(detectImageType(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' })
    expect(ALLOWED_IMAGE_TYPES).toHaveLength(4)
  })

  it('伪装成 .jpg 的 HTML/SVG/文本一律认不出来（拒绝）', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>hi</body></html>')
    expect(detectImageType(svg)).toBeNull()
    expect(detectImageType(html)).toBeNull()
    expect(detectImageType(new TextEncoder().encode('hello'))).toBeNull()
    expect(detectImageType(bytes())).toBeNull()
    // SVG 能单独识别出来，给用户更准确的原因（而不是笼统的"类型不支持"）
    expect(looksLikeSvg(svg)).toBe(true)
    expect(looksLikeSvg(html)).toBe(false)
  })
})

describe('图片本地化安全：落盘路径只由 sha256 生成（结构性排除路径穿越）', () => {
  const sha = 'a'.repeat(64)
  it('正常路径是 <前2位>/<sha256>.<ext>', () => {
    expect(mediaRelativePath(sha, 'jpg')).toBe(`aa/${sha}.jpg`)
    expect(mediaRelativePath('0123456789abcdef'.repeat(4), 'png')).toBe(`01/${'0123456789abcdef'.repeat(4)}.png`)
  })

  it('非法 sha256 直接抛（不返回半个路径）', () => {
    expect(() => mediaRelativePath('../../etc/passwd', 'jpg')).toThrow('INVALID_SHA256')
    expect(() => mediaRelativePath('', 'jpg')).toThrow('INVALID_SHA256')
    expect(() => mediaRelativePath('A'.repeat(63), 'jpg')).toThrow('INVALID_SHA256')
  })

  it('扩展名白名单化：怪扩展名降级成 bin，不会拼出可执行后缀', () => {
    expect(mediaRelativePath(sha, '../exe')).toBe(`aa/${sha}.bin`)
    expect(mediaRelativePath(sha, 'JPG')).toBe(`aa/${sha}.bin`)   // 大写不认，降级（我们只用自己算出来的小写 ext）
  })
})

describe('图片本地化安全：体积上限', () => {
  it('10MB 上限，Content-Length 缺失或超限都算超', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    expect(exceedsSizeLimit(1024)).toBe(false)
    expect(exceedsSizeLimit(MAX_IMAGE_BYTES)).toBe(false)
    expect(exceedsSizeLimit(MAX_IMAGE_BYTES + 1)).toBe(true)
    expect(exceedsSizeLimit(Number.NaN)).toBe(true)
    expect(exceedsSizeLimit(Number.POSITIVE_INFINITY)).toBe(true)
  })
})
