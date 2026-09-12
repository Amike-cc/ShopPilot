/**
 * 环境配置管理器 - §4.4 / §5.2 / §6.6 profile:*
 * browser_profiles 一行一店铺；locked=1 时拒绝更新；config_version 随更新递增。
 */

import { randomBytes, createHash } from 'crypto'
import { getDatabase } from '../db/database'

export interface BrowserProfile {
  id: string
  storeId: string
  name: string
  browserVersion: string
  osDisplay: string
  userAgent: string
  uaClientHintsJson: string | null
  language: string
  timezone: string
  screenWidth: number
  screenHeight: number
  colorDepth: number | null
  hardwareConcurrency: number | null
  webglVendor: string | null
  webglRenderer: string | null
  profilePartition: string
  configVersion: number
  configDigest: string
  profileSchemaVersion: number
  locked: boolean
  createdAt: number
  updatedAt: number
}

function mapProfileRow(row: any): BrowserProfile | null {
  if (!row) return null
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    browserVersion: row.browser_version,
    osDisplay: row.os_display,
    userAgent: row.user_agent,
    uaClientHintsJson: row.ua_client_hints_json ?? null,
    language: row.language,
    timezone: row.timezone,
    screenWidth: row.screen_width,
    screenHeight: row.screen_height,
    colorDepth: row.color_depth ?? null,
    hardwareConcurrency: row.hardware_concurrency ?? null,
    webglVendor: row.webgl_vendor ?? null,
    webglRenderer: row.webgl_renderer ?? null,
    profilePartition: row.profile_partition,
    configVersion: row.config_version,
    configDigest: row.config_digest,
    profileSchemaVersion: row.profile_schema_version,
    locked: row.locked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function digestOf(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16)
}

/**
 * 店铺创建时同步建默认环境（§8.1 步骤3）
 */
export function ensureProfileForStore(storeId: string, storeName: string): BrowserProfile {
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM browser_profiles WHERE store_id = ?').get(storeId)
  if (existing) return mapProfileRow(existing)!

  const now = Date.now()
  const id = `prof_${randomBytes(12).toString('hex')}`
  const partition = `persist:store_${storeId}`
  const defaults = {
    browserVersion: process.versions.chrome || '126.0.0.0',
    osDisplay: 'Windows 10',
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    screenWidth: 1920,
    screenHeight: 1080
  }
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${defaults.browserVersion} Safari/537.36`
  const configDigest = digestOf({ ua: userAgent, lang: defaults.language, tz: defaults.timezone, w: defaults.screenWidth, h: defaults.screenHeight })

  db.prepare(`
    INSERT INTO browser_profiles (
      id, store_id, name, browser_version, os_display, user_agent, ua_client_hints_json,
      language, timezone, screen_width, screen_height, color_depth, hardware_concurrency,
      webgl_vendor, webgl_renderer, profile_partition, config_version, config_digest,
      profile_schema_version, locked, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, storeId, `${storeName} 环境`, defaults.browserVersion, defaults.osDisplay, userAgent, null,
    defaults.language, defaults.timezone, defaults.screenWidth, defaults.screenHeight, 24, null,
    null, null, partition, 1, configDigest, 1, 0, now, now
  )

  return getProfile(storeId)!
}

export function getProfile(storeId: string): BrowserProfile | null {
  const db = getDatabase()
  return mapProfileRow(db.prepare('SELECT * FROM browser_profiles WHERE store_id = ?').get(storeId))
}

export class ProfileLockedError extends Error {
  constructor() { super('PROFILE_LOCKED'); this.name = 'ProfileLockedError' }
}

export interface ProfilePatch {
  userAgent?: string
  language?: string
  timezone?: string
  screenWidth?: number
  screenHeight?: number
  hardwareConcurrency?: number
  colorDepth?: number
  webglVendor?: string
  webglRenderer?: string
}

/**
 * 更新环境配置：locked 拒绝；config_version+1；重算 digest（§6.6）
 */
export function updateProfile(storeId: string, patch: ProfilePatch): BrowserProfile {
  const db = getDatabase()
  const current = getProfile(storeId)
  if (!current) throw new Error('PROFILE_NOT_FOUND')
  if (current.locked) throw new ProfileLockedError()

  const updates: string[] = []
  const values: any[] = []
  const fieldMap: Record<keyof ProfilePatch, string> = {
    userAgent: 'user_agent', language: 'language', timezone: 'timezone',
    screenWidth: 'screen_width', screenHeight: 'screen_height',
    hardwareConcurrency: 'hardware_concurrency', colorDepth: 'color_depth',
    webglVendor: 'webgl_vendor', webglRenderer: 'webgl_renderer'
  }
  for (const key of Object.keys(patch) as Array<keyof ProfilePatch>) {
    if (patch[key] !== undefined && fieldMap[key]) {
      updates.push(`${fieldMap[key]} = ?`)
      values.push(patch[key])
    }
  }

  const nextVersion = current.configVersion + 1
  const merged = { ...current, ...patch }
  updates.push('config_version = ?', 'config_digest = ?', 'updated_at = ?')
  values.push(nextVersion, digestOf({ ua: merged.userAgent, lang: merged.language, tz: merged.timezone, w: merged.screenWidth, h: merged.screenHeight }), Date.now(), storeId)

  db.prepare(`UPDATE browser_profiles SET ${updates.join(', ')} WHERE store_id = ?`).run(...values)
  return getProfile(storeId)!
}

/**
 * 锁定/解锁环境（§6.6 / F-ENV-003）
 */
export function lockProfile(storeId: string, locked: boolean): BrowserProfile {
  const db = getDatabase()
  const info = db.prepare('UPDATE browser_profiles SET locked = ?, updated_at = ? WHERE store_id = ?')
    .run(locked ? 1 : 0, Date.now(), storeId)
  if (info.changes === 0) throw new Error('PROFILE_NOT_FOUND')
  return getProfile(storeId)!
}

export interface ProfileVerifyItem {
  field: string
  expected: string | number | null
  actual: string | number | null
  state: 'verified' | 'unverified'
}

/**
 * 环境校验（§6.6 逐字段 实际值/期望值/已验证|未验证）
 * M2 接入页内探测后回填 actual；当前按未验证返回，字段结构与前端约定一致。
 */
export function verifyProfile(storeId: string): ProfileVerifyItem[] {
  const p = getProfile(storeId)
  if (!p) throw new Error('PROFILE_NOT_FOUND')
  return [
    { field: 'userAgent', expected: p.userAgent, actual: null, state: 'unverified' },
    { field: 'language', expected: p.language, actual: null, state: 'unverified' },
    { field: 'timezone', expected: p.timezone, actual: null, state: 'unverified' },
    { field: 'screen', expected: `${p.screenWidth}x${p.screenHeight}`, actual: null, state: 'unverified' }
  ]
}

/**
 * 复制配置（店铺右键"复制配置"，§6.6）
 * 只复制指纹配置字段，绝不复制 partition / locked / 凭据。
 */
export function copyProfileConfig(
  sourceStoreId: string,
  targetStoreIds: string[]
): { copied: number; skipped: Array<{ storeId: string; reason: string }> } {
  const db = getDatabase()
  const source = getProfile(sourceStoreId)
  if (!source) throw new Error('PROFILE_NOT_FOUND')

  let copied = 0
  const skipped: Array<{ storeId: string; reason: string }> = []
  const now = Date.now()
  for (const targetId of targetStoreIds) {
    // 目标店铺可能从未打开过浏览器（环境记录按需创建）：先补建，再复制，
    // 否则旧实现是静默跳过——界面报"已复制"实际什么都没变。
    let target = getProfile(targetId)
    if (!target) {
      const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(targetId) as { name?: string } | undefined
      if (!store) { skipped.push({ storeId: targetId, reason: 'STORE_NOT_FOUND' }); continue }
      target = ensureProfileForStore(targetId, store.name || '店铺')
    }
    if (target.locked) { skipped.push({ storeId: targetId, reason: 'PROFILE_LOCKED' }); continue }
    db.prepare(`
      UPDATE browser_profiles
      SET user_agent = ?, language = ?, timezone = ?, screen_width = ?, screen_height = ?,
          webgl_vendor = ?, webgl_renderer = ?,
          config_version = config_version + 1, updated_at = ?
      WHERE store_id = ?
    `).run(source.userAgent, source.language, source.timezone, source.screenWidth, source.screenHeight,
      source.webglVendor, source.webglRenderer, now, targetId)
    copied++
  }
  return { copied, skipped }
}
