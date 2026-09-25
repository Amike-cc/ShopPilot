/**
 * 凭据保管服务 - §16 安全存储 / §4.3
 * 代理用户名密码经 safeStorage（Windows = DPAPI）加密后存 app_settings，
 * 仅主进程可解密读取，绝不回传渲染层。
 *
 * 读写均为 fail-closed：safeStorage 不可用时拒绝保存/读取（抛
 * AGENT_MODEL_KEY_STORAGE_UNAVAILABLE，见 storageUnavailable 的说明）；唯一例外是
 * hasAiKey 这一布尔探针（启动期会走到它，见其注释），只有显式设置
 * SHOPILOT_ALLOW_PLAINTEXT_CREDENTIALS=1 才允许旧的 plain: 回退（测试/本地兜底）。
 * 写入侧任何情况下都不再产生新的 plain: 记录。
 */

import { app, safeStorage } from 'electron'
import { getDatabase } from '../db/database'
import { logMain } from './logger'

/**
 * 安全存储不可用时的统一错误（fail-closed）。
 *
 * 共享错误码枚举里没有通用凭据存储码，最接近的是 AGENT_MODEL_KEY_STORAGE_UNAVAILABLE
 *（同义："系统安全存储不可用，拒绝读写密钥"），按"不许自造散字符串"的要求沿用它的码值。
 * 错误码写进 message 前缀，是为了让上层 IPC 把可行动信息原样透给 UI。
 */
function storageUnavailable(detail: string): Error {
  return new Error(`AGENT_MODEL_KEY_STORAGE_UNAVAILABLE: ${detail}`)
}

/** 唯一放行明文回退的开关：仅给测试/本地兜底用，打包态不得设置 */
function plaintextFallbackAllowed(): boolean {
  return process.env.SHOPILOT_ALLOW_PLAINTEXT_CREDENTIALS === '1'
}

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
  // 默认 fail-closed：safeStorage 不可用时拒绝落盘，绝不产生新的 plain: 记录。
  // 例外只留给显式打开开关的测试/本地环境（打包态 §16 要求必须加密存储）。
  if (plaintextFallbackAllowed()) {
    logMain('warn', '[credential] 安全存储不可用，按 SHOPILOT_ALLOW_PLAINTEXT_CREDENTIALS=1 回退为明文存储（仅限测试/本地兜底）')
    return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
  }
  throw storageUnavailable('本机安全存储不可用，无法保存凭据；请确认系统凭据服务可用后重试')
}

function decrypt(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    // 读也 fail-closed：不把"存储不可用"静默降级成"未配置"——那会让用户以为凭据丢了，
    // 也会让代理认证静默失败
    if (!safeStorage.isEncryptionAvailable()) {
      throw storageUnavailable('本机安全存储不可用，无法读取已保存的凭据')
    }
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch (error: any) {
      // 凭据不可解密（OSCrypt 密钥未落盘、系统密钥变化、强杀/断电后的半写状态）时
      // **不能让应用启动失败**：如实当作"未配置"，由用户在设置里重新填写。
      logMain('warn', `[credential] 已存凭据无法解密（将按未配置处理）：${String(error?.message || error).slice(0, 120)}`)
      return null
    }
  }
  if (stored.startsWith('plain:')) {
    // 历史遗留的明文记录默认可读（否则用户会遇到"配置明明在、却读不出来"），
    // 但必须留一条 warn：这句日志本身就是"该凭据需要重新保存"的提示
    logMain('warn', '[credential] 读取到历史明文（plain:）凭据记录：存储曾降级，请重新保存该凭据点以恢复加密存储')
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

// ---------- 大模型 API Key（同样经 safeStorage 加密，仅主进程可解密，绝不回传渲染层） ----------

/** 单一 AI Key 的存储键；已在 diagnostics 的 SETTING_DENY 中排除，不会进诊断包 */
export const AI_KEY_SETTING = 'ai_cred.key'

export function saveAiKey(key: string): void {
  putSetting(AI_KEY_SETTING, key ? encrypt(key) : '')
}

export function getAiKey(): string | null {
  return decrypt(getSetting(AI_KEY_SETTING))
}

/**
 * 布尔探针：只回答"当前能否确认已配置 Key"。
 *
 * 为什么这里吞掉存储不可用的错误：启动期就会走到它（index.ts:293 注册 Agent 通道 →
 * agent-runtime.ensureAgentRuntimeBootstrap → ai-client.getAiConfig → hasAiKey），
 * 让它抛错等于"安全存储异常时应用起不来"——与 decrypt 里"不能让应用启动失败"同一条原则。
 * 真正的读取（getAiKey）仍然 fail-closed 抛明确错误，这里只把失败如实记为 error 日志。
 */
export function hasAiKey(): boolean {
  try {
    const k = getAiKey()
    return !!(k && k.trim())
  } catch (error: any) {
    logMain('error', `[credential] 无法确认 AI Key 是否已配置：${String(error?.message || error)}`)
    return false
  }
}

export function deleteAiKey(): void {
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(AI_KEY_SETTING)
}

// 保持 app 导入有效（文档性引用：safeStorage 需在 app.whenReady 后调用）
void app
