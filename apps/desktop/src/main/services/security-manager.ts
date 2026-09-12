/**
 * 应用锁 / 主密码 - §16 安全存储 / §187（不落明文）/ §189（锁定销毁敏感引用）
 *
 * 主密码校验信息 = scrypt(password, salt) 派生值，本身不可逆推明文；
 * 再整体经 safeStorage（DPAPI）加密存 app_settings，双重满足"不得明文落盘"。
 * 锁定态：销毁 lastProxyAuth 等敏感内存引用，业务 IPC 由中央门禁拒绝（见 index.ts）。
 */

import { app, safeStorage } from 'electron'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { askPassword } from './password-dialog'

const MASTER_KEY = 'securi…ster'
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
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(json).toString('base64')
    : 'plain:' + Buffer.from(json, 'utf8').toString('base64')
}
function unseal(stored: string | null): any {
  if (!stored) return null
  try {
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
  return !!unseal(get(MASTER_KEY))
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
  put(MASTER_KEY, seal({ salt: salt.toString('base64'), hash }))
  writeAudit('security.setPassword', 'success')
  return { ok: true }
}

export function removeMasterPassword(credential?: string | null): { ok: boolean } {
  if (!hasMasterPassword()) return { ok: true }
  const given = credential ?? ''
  if (!verifyMaster(given)) throw new Error('APP_LOCKED: 主密码不正确，无法移除')
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(MASTER_KEY)
  if (locked) locked = false
  writeAudit('security.removePassword', 'success')
  return { ok: true }
}

export function verifyMaster(password: string): boolean {
  const rec = unseal(get(MASTER_KEY))
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

export function unlockApp(credential: string): boolean {
  if (!hasMasterPassword()) { locked = false; return true }
  if (!verifyMaster(credential)) {
    writeAudit('security.unlock', 'failure')
    return false
  }
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

// void app 供 tree-shaker 保留 electron 依赖声明
void app
