/**
 * 应用锁 / 主密码 - §16 安全存储 / §187（不落明文）/ §189（锁定销毁敏感引用）
 *
 * 主密码校验信息 = scrypt(password, salt) 派生值，本身不可逆推明文；
 * 再整体经 safeStorage（DPAPI）加密存 app_settings，双重满足"不得明文落盘"。
 * 锁定态：销毁 lastProxyAuth 等敏感内存引用，业务 IPC 由中央门禁拒绝（见 index.ts）。
 */

import { safeStorage } from 'electron'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { askPassword } from './password-dialog'
import { logMain } from './logger'

/**
 * 主密码记录在 app_settings 里的键。
 *
 * B3/B4（2026-10-15 审查）：历史字面量是 `'securi…ster'`（中间是 U+2026 省略号，疑似
 * 占位符未还原），与诊断包排除名单里的 `'security.master'` 对不上——"排除主密码"的防呆
 * 条目从未生效（靠导出白名单兜底才没有泄漏）。现在统一为 `'security.master'`：
 * 写入只用新键；读取兼容旧键并**就地迁移**（见 resolveMasterStoredKey / readMasterStored）。
 */
export const MASTER_PASSWORD_SETTING_KEY = 'security.master'
/** 历史键（含 U+2026），只为读取迁移而保留；新写入永不再用。 */
export const LEGACY_MASTER_PASSWORD_SETTING_KEY = 'securi…ster'

/**
 * 从两个候选键解析主密码记录（纯函数，单测钉住优先级）：
 * 新键优先；只有旧键时返回旧键并标记 legacyKey（调用方负责迁移）；都没有返回 null。
 */
export function resolveMasterStoredKey(read: (key: string) => string | null): { stored: string | null; legacyKey: string | null } {
  const fresh = read(MASTER_PASSWORD_SETTING_KEY)
  if (fresh) {
    return { stored: fresh, legacyKey: read(LEGACY_MASTER_PASSWORD_SETTING_KEY) ? LEGACY_MASTER_PASSWORD_SETTING_KEY : null }
  }
  const legacy = read(LEGACY_MASTER_PASSWORD_SETTING_KEY)
  return legacy ? { stored: legacy, legacyKey: LEGACY_MASTER_PASSWORD_SETTING_KEY } : { stored: null, legacyKey: null }
}

/** 读取主密码记录；从旧键读到时就地迁移到新键（失败不影响本次读取，下次再试）。 */
function readMasterStored(): string | null {
  const resolved = resolveMasterStoredKey(get)
  if (resolved.legacyKey && resolved.stored) {
    try {
      put(MASTER_PASSWORD_SETTING_KEY, resolved.stored)
      getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(LEGACY_MASTER_PASSWORD_SETTING_KEY)
      logMain('info', '[security] 主密码记录已从历史键迁移到 security.master')
    } catch { /* 迁移失败不影响读取；旧键仍在，下次再试 */ }
  }
  return resolved.stored
}

const IDLE_KEY = 'security.idleMinutes' // 与 settings:set 同键（UI 可直接维护）
const SALT = Buffer.from('shopilot-applock') // 固定域分离盐，配合随机盐双层
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }

let locked = false

export interface LockStatus {
  enabled: boolean   // 是否设置了主密码
  locked: boolean
  idleMinutes: number
}

function put(key: string, val: string): void {
  getDatabase().prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, val, Date.now())
}
function get(key: string): string | null {
  const r = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as any
  return r ? r.value_json : null
}

function seal(obj: unknown): string {
  const json = JSON.stringify(obj)
  // 主密码校验值虽然不是密码原文，但它是应用锁的安全根；safeStorage 不可用时
  // 写入 Base64 只是在伪装明文，且与凭据/记忆服务的 fail-closed 策略不一致。
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('SECURITY_STORAGE_UNAVAILABLE: 系统安全存储不可用，拒绝保存主密码')
  }
  return 'enc:' + safeStorage.encryptString(json).toString('base64')
}
function unseal(stored: string | null): any {
  if (!stored) return null
  try {
    // 兼容读取历史 plain: 校验值（其中只有 scrypt 派生值，不是密码原文），
    // 但新写入永远不会再降级为 plain:；用户更换密码后会自动迁移到 enc:。
    const raw = stored.startsWith('enc:')
      ? (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) : null)
      : stored.startsWith('plain:') ? Buffer.from(stored.slice(6), 'base64').toString('utf8') : null
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.concat([SALT, Buffer.from(password, 'utf8')]), salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 })
}

export function hasMasterPassword(): boolean {
  const stored = readMasterStored()
  // 已有加密记录但系统暂时没有可用的 safeStorage 时，必须仍视为“已启用”。
  // 否则应用会把安全存储故障误判成“用户未设置主密码”，从而绕过锁定门禁。
  if (stored?.startsWith('enc:') && !safeStorage.isEncryptionAvailable()) return true
  return !!unseal(stored)
}

/** 设置/更换主密码；已设置时需旧密码。
 * UI 路径传 {password, oldPassword}；缺省则回退主进程托管对话框。 */
export async function setMasterPassword(input: { password?: string; oldPassword?: string } = {}): Promise<{ ok: boolean }> {
  if (hasMasterPassword()) {
    let old = input.oldPassword ?? null
    if (old === null) old = await askPassword({ title: '验证当前主密码', detail: '更换主密码前需验证旧密码' })
    if (!old) throw new Error('SESSION_CANCELLED: 未提供旧密码')
    if (!verifyMaster(old)) throw new Error('APP_LOCKED: 旧密码不正确')
  }
  let next = input.password ?? null
  if (next === null) next = await askPassword({ title: '设置主密码', detail: '用于应用锁；锁定后需主密码解锁', requireConfirm: true })
  if (!next) throw new Error('SESSION_CANCELLED: 未设置主密码')
  if (next.length < 8) throw new Error('APP_LOCKED: 主密码至少 8 位')
  const salt = randomBytes(16)
  const hash = derive(next, salt).toString('base64')
  put(MASTER_PASSWORD_SETTING_KEY, seal({ salt: salt.toString('base64'), hash }))
  // 换/设密码时旧键若还有残留（历史半迁移状态），一并清掉，避免两键并存
  try { getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(LEGACY_MASTER_PASSWORD_SETTING_KEY) } catch { /* 清理失败不影响新密码已生效 */ }
  writeAudit('security.setPassword', 'success')
  return { ok: true }
}

export function removeMasterPassword(credential?: string | null): { ok: boolean } {
  if (!hasMasterPassword()) return { ok: true }
  const given = credential ?? ''
  if (!verifyMaster(given)) throw new Error('APP_LOCKED: 主密码不正确，无法移除')
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(MASTER_PASSWORD_SETTING_KEY)
  // 旧键一并清（未迁移完的库里两键可能并存）
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(LEGACY_MASTER_PASSWORD_SETTING_KEY)
  if (locked) locked = false
  writeAudit('security.removePassword', 'success')
  return { ok: true }
}

export function verifyMaster(password: string): boolean {
  const stored = readMasterStored()
  if (stored?.startsWith('enc:') && !safeStorage.isEncryptionAvailable()) {
    throw new Error('SECURITY_STORAGE_UNAVAILABLE: 系统安全存储不可用，无法验证主密码')
  }
  const rec = unseal(stored)
  if (!rec?.salt || !rec?.hash) return false
  const expect = Buffer.from(rec.hash, 'base64')
  const got = derive(password, Buffer.from(rec.salt, 'base64'))
  return expect.length === got.length && timingSafeEqual(expect, got)
}

export function lockApp(): void {
  if (!hasMasterPassword()) return
  if (locked) return
  locked = true
  writeAudit('security.lock', 'success')
  destroySensitive() // §189 敏感内存引用销毁
}

/**
 * 解锁尝试限流（P3，2026-10-15 审查）：scrypt 已让每次尝试很慢，再加一层**进程内**计数——
 * 连续失败 ≥5 次后指数退避（1s、2s、4s… 封顶 60s），成功即清零。
 * 刻意的内存态：重启应用即清零，避免"忘记密码 + 退避状态持久化"把人永久锁在门外。
 * （退避期间以 APP_LOCKED 结果如实拒绝，界面文案与密码错误一致，不泄露限流细节。）
 */
let unlockFailureCount = 0
let unlockBlockedUntil = 0
const UNLOCK_FREE_ATTEMPTS = 5
const UNLOCK_MAX_BACKOFF_MS = 60_000

export function unlockApp(credential: string): boolean {
  if (!hasMasterPassword()) { locked = false; return true }
  const now = Date.now()
  if (now < unlockBlockedUntil) {
    writeAudit('security.unlock', 'failure')
    return false
  }
  if (!verifyMaster(credential)) {
    unlockFailureCount++
    if (unlockFailureCount >= UNLOCK_FREE_ATTEMPTS) {
      const backoff = Math.min(UNLOCK_MAX_BACKOFF_MS, 1000 * 2 ** (unlockFailureCount - UNLOCK_FREE_ATTEMPTS))
      unlockBlockedUntil = now + backoff
    }
    writeAudit('security.unlock', 'failure')
    return false
  }
  unlockFailureCount = 0
  unlockBlockedUntil = 0
  locked = false
  writeAudit('security.unlock', 'success')
  return true
}

export function isAppLocked(): boolean { return locked }

let destroyHook: (() => void) | null = null
export function setDestroySensitiveHook(fn: () => void): void { destroyHook = fn }
function destroySensitive(): void { try { destroyHook?.() } catch { /* 忽略清理异常 */ } }

export function getIdleMinutes(): number {
  const v = parseInt(get(IDLE_KEY) || '0', 10)
  return Number.isFinite(v) && v >= 0 && v <= 720 ? v : 0
}
export function setIdleMinutes(min: number): { ok: boolean } {
  const v = Math.max(0, Math.min(720, Math.floor(Number(min) || 0)))
  put(IDLE_KEY, String(v))
  return { ok: true }
}

export function getStatus(): LockStatus {
  return { enabled: hasMasterPassword(), locked, idleMinutes: getIdleMinutes() }
}
