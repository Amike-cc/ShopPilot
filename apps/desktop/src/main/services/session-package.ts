/**
 * 会话包格式与加解密（纯函数，无 Electron 依赖，便于单元测试）- §10.2
 *
 * 格式：'SHSP'(4B) | u32le headerLen | header(JSON，同时作为 GCM AAD) | u32le ctLen | AES-256-GCM 密文 | tag(16B)
 * 安全要点：
 *  - KDF 参数（scrypt N/r/p/keyLen + 随机 salt）随包携带；随机 12B nonce。
 *  - header 作为 AAD 参与认证：改有效期、改来源名都会导致解密失败。
 *  - 有效期由明文 header 与密文载荷双重承载，过期一律拒绝。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

export const MAGIC = 'SHSP'
export const PKG_VERSION = 1
export const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }
const MAXMEM = 64 * 1024 * 1024

export interface SessionCookieEntry {
  name: string; domain: string; path: string; value: string
  secure: boolean; httpOnly: boolean
  expirationDate: number | null
  sameSite: string | null
}

export interface SessionPackagePayload {
  v: number
  srcStoreId: string
  srcStoreName: string
  srcPlatform: string
  exportedAt: number
  expiresAt: number
  profile: Record<string, unknown> | null
  cookies: SessionCookieEntry[]
}

export type SessionPackageErrorCode = 'SESSION_IMPORT_INVALID' | 'SESSION_PACKAGE_EXPIRED'

export class SessionPackageError extends Error {
  code: SessionPackageErrorCode
  constructor(code: SessionPackageErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

function packU32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLen: number }): Buffer {
  return scryptSync(password, salt, params.keyLen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM })
}

/** 打包（含有效期计算）。validDays 允许为负，用于验收过期路径。 */
export function packSession(
  password: string,
  payload: Omit<SessionPackagePayload, 'v' | 'exportedAt' | 'expiresAt'>,
  validDays: number,
  now: number = Date.now()
): { file: Buffer; expiresAt: number } {
  const expiresAt = now + validDays * 24 * 3600 * 1000
  const body: SessionPackagePayload = { v: PKG_VERSION, ...payload, exportedAt: now, expiresAt }

  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const key = deriveKey(password, salt, SCRYPT)
  const header = Buffer.from(JSON.stringify({
    v: PKG_VERSION, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLen: SCRYPT.keyLen,
    salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    exportedAt: now, expiresAt, srcStoreName: body.srcStoreName, srcPlatform: body.srcPlatform
  }), 'utf8')

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(header)
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return { file: Buffer.concat([Buffer.from(MAGIC, 'ascii'), packU32(header.length), header, packU32(ct.length), ct, tag]), expiresAt }
}

export interface UnpackedPackage {
  payload: SessionPackagePayload
  headerMeta: { exportedAt: number; expiresAt: number; srcStoreName: string; srcPlatform: string }
}

/** 解包：结构/版本/认证/有效期任一不合规即抛出对应错误码。 */
export function unpackSession(password: string, buf: Buffer, now: number = Date.now()): UnpackedPackage {
  if (buf.length < MAGIC.length + 8 || buf.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw new SessionPackageError('SESSION_IMPORT_INVALID', '不是有效的 ShopPilot 会话包')
  }

  const invalid = (why: string) => new SessionPackageError('SESSION_IMPORT_INVALID', why)

  let off = 4
  if (buf.length < off + 4) throw invalid('包结构异常')
  const headerLen = buf.readUInt32LE(off); off += 4
  if (headerLen <= 0 || off + headerLen + 4 > buf.length) throw invalid('包结构异常')
  const header = buf.subarray(off, off + headerLen); off += headerLen
  const ctLen = buf.readUInt32LE(off); off += 4
  if (ctLen <= 0 || off + ctLen + 16 !== buf.length) throw invalid('包结构异常')
  const ct = buf.subarray(off, off + ctLen); off += ctLen
  const tag = buf.subarray(off, off + 16)

  let h: any
  try { h = JSON.parse(header.toString('utf8')) } catch { throw invalid('包头无法解析') }
  if (h.v !== PKG_VERSION || h.kdf !== 'scrypt') throw invalid('不支持的包版本或 KDF')
  if (typeof h.N !== 'number' || typeof h.r !== 'number' || typeof h.p !== 'number' || typeof h.keyLen !== 'number') {
    throw invalid('缺少 KDF 参数')
  }

  let plain: string
  try {
    const key = deriveKey(password, Buffer.from(h.salt, 'base64'), { N: h.N, r: h.r, p: h.p, keyLen: h.keyLen })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(h.nonce, 'base64'))
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw invalid('密码错误或包已被篡改（认证失败）')
  }

  let payload: SessionPackagePayload
  try { payload = JSON.parse(plain) } catch { throw invalid('载荷无法解析') }
  if (payload.v !== PKG_VERSION) throw invalid('载荷版本异常')
  if (typeof payload.expiresAt !== 'number' || typeof h.expiresAt !== 'number') throw invalid('缺少有效期')
  // 有效期双重校验：明文头被 AAD 保护，载荷内再核一次，取更早者
  const effective = Math.min(payload.expiresAt, h.expiresAt)
  if (effective <= now) throw new SessionPackageError('SESSION_PACKAGE_EXPIRED', '会话包已过期，拒绝导入')

  return {
    payload,
    headerMeta: { exportedAt: h.exportedAt, expiresAt: h.expiresAt, srcStoreName: h.srcStoreName, srcPlatform: h.srcPlatform }
  }
}
