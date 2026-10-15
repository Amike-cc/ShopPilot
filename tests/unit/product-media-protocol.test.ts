import { describe, expect, it } from 'vitest'
import { resolveMediaFilePath } from '../../apps/desktop/src/main/products/product-media-protocol'
import { join } from 'node:path'

/**
 * v4 重设计 §4.7：`shopilot-media://` 只读协议的三层校验（测试清单 9.2
 * `product-media-protocol.test.ts`：穿越/越界/白名单）。
 *
 * 这是**安全边界**：协议把 userData/product-media 下的文件直接喂给渲染层 <img>，
 * 校验被绕过 = 渲染层可读任意本地文件。规则改动必须有这组测试盯着。
 */
const MEDIA_ROOT = join('D:', 'userData-root', 'product-media')
const OK_URL = (rel: string): string => `shopilot-media://local/${rel}`

describe('resolveMediaFilePath：协议路径三层校验', () => {
  it('合法路径：local host + 根内相对路径 + 图片扩展名 → 返回绝对路径', () => {
    const resolved = resolveMediaFilePath(OK_URL('ab/abcdef.jpg'), MEDIA_ROOT)
    expect(resolved).toBe(join(MEDIA_ROOT, 'ab', 'abcdef.jpg'))
    expect(resolveMediaFilePath(OK_URL('ab%2Fabcdef.PNG'), MEDIA_ROOT)).toBe(join(MEDIA_ROOT, 'ab', 'abcdef.PNG'))
  })

  it('穿越防护：编码点段（%2e%2e）逃逸一律拒绝；字面 .. 被 WHATWG 规范化留在根内', () => {
    // 真逃逸向量：URL 不规范化 %2e%2e，decode 后才出现 ../.. —— 必须 null（根内检查兜住）
    expect(resolveMediaFilePath(OK_URL('..%2F..%2Fsecret.txt'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('%2e%2e%2f%2e%2e%2fsecret.png'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('ab/..%5c..%5csecret.png'), MEDIA_ROOT)).toBeNull()
    // 字面 ../.. 会被 WHATWG URL 规范化吃掉（等于根内路径），落在根内属安全形态
    const normalized = resolveMediaFilePath(OK_URL('ab/../../secret.png'), MEDIA_ROOT)
    expect(normalized).toBe(join(MEDIA_ROOT, 'secret.png'))
  })

  it('越界防护：盘符绝对路径与 UNC 形态拒绝', () => {
    expect(resolveMediaFilePath(OK_URL('C:/windows/win.ini'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('D:/other-root/secret.png'), MEDIA_ROOT)).toBeNull()
  })

  it('host 白名单：非 local 一律拒绝', () => {
    expect(resolveMediaFilePath('shopilot-media://evil/ab/abcdef.jpg', MEDIA_ROOT)).toBeNull()
  })

  it('扩展名白名单：只服务图片，不服务任意文件', () => {
    expect(resolveMediaFilePath(OK_URL('ab/abcdef.txt'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('ab/abcdef.exe'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('ab/abcdef'), MEDIA_ROOT)).toBeNull()
    expect(resolveMediaFilePath(OK_URL('ab/abcdef.svg'), MEDIA_ROOT)).toBeNull() // SVG 可内嵌脚本，明确拒绝
  })

  it('畸形 URL：解析失败返回 null（不抛）', () => {
    expect(resolveMediaFilePath('not a url', MEDIA_ROOT)).toBeNull()
  })
})
