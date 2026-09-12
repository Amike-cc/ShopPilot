import { describe, it, expect } from 'vitest'
import { packSession, unpackSession, SessionPackageError, MAGIC, SCRYPT, type SessionCookieEntry } from '../../apps/desktop/src/main/services/session-package'

// 注意：密文是随机字节，"值不得出现在文件里"的断言必须用足够长的标记，
// 否则 2 字节短值有 ~1% 概率随机命中密文造成偶发误报（曾实测到一次）。
const cookies: SessionCookieEntry[] = [
  { name: 'SID', domain: '.example.com', path: '/', value: 'SID_VALUE_3f9a1c7e5b2d8a4097c6', secure: true, httpOnly: true, expirationDate: null, sameSite: 'Lax' },
  { name: 'PLAIN', domain: 'example.com', path: '/a', value: 'PLAIN_VALUE_a71b93c2e6f4d5081234', secure: false, httpOnly: false, expirationDate: 1893456000, sameSite: null }
]

const base = {
  srcStoreId: 'store_1',
  srcStoreName: '测试店铺',
  srcPlatform: '拼多多',
  profile: { timezone: 'Asia/Shanghai', screenWidth: 1920 },
  cookies
}

describe('会话包格式（§10.2）', () => {
  it('打包后可原样解回，魔数/KDF 参数/有效期字段齐全', () => {
    const { file, expiresAt } = packSession('pw-12345678', base, 30, 1700000000000)
    expect(file.subarray(0, 4).toString('ascii')).toBe(MAGIC)
    const headerLen = file.readUInt32LE(4)
    const header = JSON.parse(file.subarray(8, 8 + headerLen).toString('utf8'))
    expect(header.kdf).toBe('scrypt')
    expect(header.N).toBe(SCRYPT.N)
    expect(header.r).toBe(SCRYPT.r)
    expect(header.p).toBe(SCRYPT.p)
    expect(header.keyLen).toBe(SCRYPT.keyLen)
    expect(typeof header.salt).toBe('string')
    expect(header.expiresAt).toBe(expiresAt)
    expect(expiresAt).toBe(1700000000000 + 30 * 86400000)

    const out = unpackSession('pw-12345678', file, 1700000000000)
    expect(out.payload.cookies).toHaveLength(2)
    expect(out.payload.cookies[0].httpOnly).toBe(true)
    expect(out.payload.srcStoreName).toBe('测试店铺')
    expect(out.payload.profile).toEqual(base.profile)
  })

  it('密文边界：Cookie 值不明文可见；包头仅暴露来源店铺/平台/有效期（供导入前确认来源）', () => {
    const { file } = packSession('pw-12345678', base, 30, 1700000000000)
    const headerLen = file.readUInt32LE(4)
    const headerText = file.subarray(8, 8 + headerLen).toString('utf8')
    // 敏感载荷（Cookie 值与域、指纹配置）必须在密文内
    expect(file.includes(Buffer.from('SID_VALUE_3f9a1c7e5b2d8a4097c6'))).toBe(false)
    expect(file.includes(Buffer.from('PLAIN_VALUE_a71b93c2e6f4d5081234'))).toBe(false)
    expect(file.includes(Buffer.from('.example.com'))).toBe(false)
    expect(file.includes(Buffer.from('Asia/Shanghai'))).toBe(false)
    // 明文头只含来源元信息（导入前需向用户展示），不含 Cookie 内容
    expect(headerText).toContain('测试店铺')
    expect(headerText).toContain('"kdf":"scrypt"')
  })

  it('口令错误 → 认证失败（不泄露明文）', () => {
    const { file } = packSession('pw-12345678', base, 30, 1700000000000)
    let err: any = null
    try { unpackSession('wrong-password', file, 1700000000000) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SessionPackageError)
    expect(err.code).toBe('SESSION_IMPORT_INVALID')
    expect(String(err.message)).toContain('认证失败')
  })

  it('密文被篡改 1 字节 → 拒绝导入', () => {
    const { file } = packSession('pw-12345678', base, 30, 1700000000000)
    const tampered = Buffer.from(file)
    tampered[tampered.length - 20] ^= 0xff
    expect(() => unpackSession('pw-12345678', tampered, 1700000000000)).toThrow(SessionPackageError)
  })

  it('头部被篡改（AAD 绑定）→ 拒绝导入', () => {
    const { file } = packSession('pw-12345678', base, 30, 1700000000000)
    const headerLen = file.readUInt32LE(4)
    const header = JSON.parse(file.subarray(8, 8 + headerLen).toString('utf8'))
    header.expiresAt = header.expiresAt + 86400000 // 试图延长有效期
    const forged = Buffer.from(JSON.stringify(header), 'utf8')
    const tampered = Buffer.concat([Buffer.from(MAGIC, 'ascii'), u32(forged.length), forged, file.subarray(8 + headerLen)])
    let err: any = null
    try { unpackSession('pw-12345678', tampered, 1700000000000) } catch (e) { err = e }
    expect(err?.code).toBe('SESSION_IMPORT_INVALID')
  })

  it('结构截断 → 包结构异常', () => {
    const { file } = packSession('pw-12345678', base, 30, 1700000000000)
    const truncated = file.subarray(0, file.length - 4)
    let err: any = null
    try { unpackSession('pw-12345678', truncated, 1700000000000) } catch (e) { err = e }
    expect(err?.code).toBe('SESSION_IMPORT_INVALID')
    expect(String(err.message)).toContain('包结构异常')
  })

  it('过期包 → SESSION_PACKAGE_EXPIRED（§14 强制有效期）', () => {
    const { file, expiresAt } = packSession('pw-12345678', base, 1, 1700000000000)
    const out = unpackSession('pw-12345678', file, expiresAt - 1000)
    expect(out.payload.cookies).toHaveLength(2)
    let err: any = null
    try { unpackSession('pw-12345678', file, expiresAt + 1000) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SessionPackageError)
    expect(err.code).toBe('SESSION_PACKAGE_EXPIRED')
  })

  it('非本程序文件 → 明确拒绝', () => {
    let err: any = null
    try { unpackSession('pw', Buffer.from('PK\x03\x04 totally not a session package')) } catch (e) { err = e }
    expect(err?.code).toBe('SESSION_IMPORT_INVALID')
    expect(String(err.message)).toContain('不是有效的 ShopPilot 会话包')
  })

  it('每次打包 salt/nonce 不同（同口令同载荷密文也不同）', () => {
    const a = packSession('pw-12345678', base, 30, 1700000000000).file
    const b = packSession('pw-12345678', base, 30, 1700000000000).file
    expect(a.equals(b)).toBe(false)
  })
})

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}
