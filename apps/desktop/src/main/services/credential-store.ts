/**
 * 凭据保管服务 - §16 安全存储 / §4.3
 * 代理用户名密码经 safeStorage（Windows = DPAPI）加密后存 app_settings，
 * 仅主进程可解密读取，绝不回传渲染层。
 */

import { app, safeStorage } from 'electron'
import { getDatabase } from '../db/database'

function keyFor(proxyId: string, field: 'u' | 'p'): string {
  return `proxy_cred.${proxyId}.${field}`
}

function putSetting(key: string, value: string): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, value, Date.now())
}

function getSetting(key: string): string | null {
  const db = getDatabase()
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as any
  return row ? row.value_json : null
}

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  }
  // 开发回退：明文（M2 打包前必须保证 safeStorage 可用，§16）
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
}

function decrypt(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  }
  return null
}

export function saveProxyCredentials(proxyId: string, username?: string | null, password?: string | null): void {
  if (username !== undefined) putSetting(keyFor(proxyId, 'u'), username === null ? '' : encrypt(username))
  if (password !== undefined) putSetting(keyFor(proxyId, 'p'), password === null ? '' : encrypt(password))
}

export function getProxyCredentials(proxyId: string): { username: string; password: string } | null {
  const username = decrypt(getSetting(keyFor(proxyId, 'u')))
  const password = decrypt(getSetting(keyFor(proxyId, 'p')))
  if (username === null && password === null) return null
  return { username: username ?? '', password: password ?? '' }
}

export function deleteProxyCredentials(proxyId: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run(keyFor(proxyId, 'u'), keyFor(proxyId, 'p'))
}

/** 供代理表 username_ref/password_ref 记录引用键（不存明文凭据） */
export function credentialRefs(proxyId: string): { usernameRef: string; passwordRef: string } {
  return { usernameRef: keyFor(proxyId, 'u'), passwordRef: keyFor(proxyId, 'p') }
}

// 保持 app 导入有效（文档性引用：safeStorage 需在 app.whenReady 后调用）
void app
