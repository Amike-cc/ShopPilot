/**
 * 店铺管理器 - §4.2 Main 职责
 * 负责店铺的 CRUD 操作和状态管理
 */

import { randomBytes } from 'crypto'
import { app, session } from 'electron'
import { rmSync } from 'fs'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { ensureProfileForStore } from './profile-manager'
import { writeAudit } from '../services/audit-logger'
import type { Store, StoreCreateInput, StoreUpdateInput } from '@shared/schemas/store'
import { normalizeLicenseName, normalizeLicenseNo } from '@shared/store-license'
import { StoreStatus } from '@shared/enums/store-status'

/**
 * 生成店铺 ID
 */
function generateStoreId(): string {
  return `store_${randomBytes(16).toString('hex')}`
}

/**
 * 生成店铺头像颜色 - §5.1 按 ID 哈希分配
 */
function generateAvatarColor(storeId: string): string {
  const colors = [
    '#3B82F6', // blue
    '#8B5CF6', // purple
    '#EC4899', // pink
    '#F59E0B', // amber
    '#10B981', // emerald
    '#06B6D4', // cyan
    '#F97316', // orange
    '#6366F1'  // indigo
  ]
  
  // 简单哈希
  let hash = 0
  for (let i = 0; i < storeId.length; i++) {
    hash = ((hash << 5) - hash) + storeId.charCodeAt(i)
    hash = hash & hash
  }
  
  return colors[Math.abs(hash) % colors.length]
}

/**
 * 数据库行（snake_case）→ Store（camelCase）
 * SELECT * 返回的是列名原样，必须映射，否则渲染层 avatarColor/adminUrl 为 undefined
 */
function mapStoreRow(row: any): Store | null {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    adminUrl: row.admin_url,
    status: row.status,
    avatarColor: row.avatar_color,
    sortOrder: row.sort_order,
    groupName: row.group_name ?? null,
    externalCode: row.external_code ?? null,
    owner: row.owner ?? null,
    region: row.region ?? null,
    licenseName: row.license_name ?? null,
    licenseNo: row.license_no ?? null,
    tagsJson: row.tags_json,
    notes: row.notes ?? null,
    lastActiveAt: row.last_active_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null
  }
}

/**
 * 列出所有店铺
 */
export function listStores(): Store[] {
  const db = getDatabase()
  const stmt = db.prepare(`
    SELECT * FROM stores 
    WHERE deleted_at IS NULL 
    ORDER BY sort_order ASC, created_at DESC
  `)
  
  return stmt.all().map(mapStoreRow) as Store[]
}

/**
 * 回收站列表（软删除店铺）- §11.2 F-STORE-004
 */
export function listTrashStores(): Store[] {
  const db = getDatabase()
  const stmt = db.prepare(`
    SELECT * FROM stores
    WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC
  `)
  return stmt.all().map(mapStoreRow) as Store[]
}

/**
 * 获取单个店铺
 */
export function getStore(storeId: string): Store | null {
  const db = getDatabase()
  const stmt = db.prepare('SELECT * FROM stores WHERE id = ? AND deleted_at IS NULL')
  
  return mapStoreRow(stmt.get(storeId))
}

/**
 * 创建店铺 - §8.1
 */
export function createStore(input: StoreCreateInput): Store {
  const db = getDatabase()
  const now = Date.now()
  const storeId = generateStoreId()
  const avatarColor = generateAvatarColor(storeId)
  
  const store = {
    id: storeId,
    name: input.name,
    platform: input.platform,
    adminUrl: input.adminUrl || '',  // 规范 NOT NULL；向导中可选 → 空串兜底
    status: StoreStatus.INCOMPLETE,
    avatarColor,
    sortOrder: 0,
    groupName: null,
    externalCode: input.externalCode || null,
    owner: input.owner || null,
    region: input.region || null,
    // 归一化后再落库：否则"上海 XX 有限公司"与"上海XX有限公司"会被当成两个主体，
    // 发票中心按主体分账就会拆成两份（归一化规则见 shared/store-license.ts）
    licenseName: normalizeLicenseName(input.licenseName) || null,
    licenseNo: normalizeLicenseNo(input.licenseNo) || null,
    tagsJson: JSON.stringify(input.tags || []),
    notes: input.notes || null,
    lastActiveAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  }
  
  const stmt = db.prepare(`
    INSERT INTO stores (
      id, name, platform, admin_url, status, avatar_color,
      sort_order, group_name, external_code, owner, region,
      license_name, license_no,
      tags_json, notes, last_active_at, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    store.id, store.name, store.platform, store.adminUrl, store.status,
    store.avatarColor, store.sortOrder, store.groupName, store.externalCode,
    store.owner, store.region, store.licenseName, store.licenseNo,
    store.tagsJson, store.notes, store.lastActiveAt,
    store.createdAt, store.updatedAt, store.deletedAt
  )

  // §8.1 步骤3：同步创建 browser_profiles 记录
  ensureProfileForStore(storeId, input.name)
  writeAudit('store.create', 'success', { storeId })

  return store as Store
}

/**
 * 更新店铺
 */
export function updateStore(input: StoreUpdateInput): Store | null {
  const db = getDatabase()
  const existing = getStore(input.storeId)
  
  if (!existing) {
    return null
  }
  
  const updates: string[] = []
  const values: any[] = []
  
  if (input.patch.name !== undefined) {
    updates.push('name = ?')
    values.push(input.patch.name)
  }
  if (input.patch.platform !== undefined) {
    updates.push('platform = ?')
    values.push(input.patch.platform)
  }
  if (input.patch.adminUrl !== undefined) {
    updates.push('admin_url = ?')
    values.push(input.patch.adminUrl)
  }
  if (input.patch.tags !== undefined) {
    updates.push('tags_json = ?')
    values.push(JSON.stringify(input.patch.tags))
  }
  if (input.patch.notes !== undefined) {
    updates.push('notes = ?')
    values.push(input.patch.notes)
  }
  if (input.patch.externalCode !== undefined) {
    updates.push('external_code = ?')
    values.push(input.patch.externalCode)
  }
  if (input.patch.owner !== undefined) {
    updates.push('owner = ?')
    values.push(input.patch.owner)
  }
  if (input.patch.region !== undefined) {
    updates.push('region = ?')
    values.push(input.patch.region)
  }
  if (input.patch.groupName !== undefined) {
    updates.push('group_name = ?')
    values.push(input.patch.groupName)
  }
  // 营业执照：空串 = 清空（落到 NULL，界面据此显示"未填写"）
  if (input.patch.licenseName !== undefined) {
    updates.push('license_name = ?')
    values.push(normalizeLicenseName(input.patch.licenseName) || null)
  }
  if (input.patch.licenseNo !== undefined) {
    updates.push('license_no = ?')
    values.push(normalizeLicenseNo(input.patch.licenseNo) || null)
  }
  
  if (updates.length === 0) {
    return existing
  }
  
  updates.push('updated_at = ?')
  values.push(Date.now())
  values.push(input.storeId)
  
  const stmt = db.prepare(`
    UPDATE stores SET ${updates.join(', ')} WHERE id = ?
  `)
  
  stmt.run(...values)
  
  return getStore(input.storeId)
}

/**
 * 恢复店铺 - §9.1 archived -> offline；回收站（deleted_at）→ offline
 */
export function restoreStore(storeId: string): boolean {
  const db = getDatabase()
  const info = db.prepare(`
    UPDATE stores 
    SET status = ?, deleted_at = NULL, updated_at = ?
    WHERE id = ? AND (status = ? OR deleted_at IS NOT NULL)
  `).run(StoreStatus.OFFLINE, Date.now(), storeId, StoreStatus.ARCHIVED)
  if (info.changes > 0) writeAudit('store.restore', 'success', { storeId })
  return info.changes > 0
}

/**
 * 归档店铺 - §9.1 any -> archived
 */
export function archiveStore(storeId: string): boolean {
  const db = getDatabase()
  const stmt = db.prepare(`
    UPDATE stores 
    SET status = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `)
  
  const info = stmt.run(StoreStatus.ARCHIVED, Date.now(), storeId)
  if (info.changes > 0) writeAudit('store.archive', 'success', { storeId })
  return info.changes > 0
}

/**
 * 移入回收站（软删除）- §6.1 store:deletePermanent
 */
export function deleteStorePermanent(storeId: string): boolean {
  const db = getDatabase()
  
  // 软删除标记
  const stmt = db.prepare(`
    UPDATE stores 
    SET deleted_at = ?, updated_at = ?
    WHERE id = ?
  `)
  
  const info = stmt.run(Date.now(), Date.now(), storeId)
  if (info.changes > 0) writeAudit('store.deletePermanent', 'success', { storeId })
  return info.changes > 0
}

/**
 * 彻底删除（回收站内"删除不可撤销"，§10.2 / §27）
 * 物理删除 stores 及级联行、session partition、店铺下载目录。
 */
export async function purgeStore(storeId: string): Promise<boolean> {
  const db = getDatabase()
  const row = db.prepare('SELECT id FROM stores WHERE id = ? AND deleted_at IS NOT NULL').get(storeId)
  if (!row) return false

  // 先写审计（此时 stores 行仍在，满足 audit_logs.store_id 外键；
  // 删除 store 后该行 store_id 依 ON DELETE SET NULL 置空，审计记录本身保留）
  writeAudit('store.purge', 'success', { storeId })

  // 级联删除依赖行（foreign_keys ON，ON DELETE CASCADE 覆盖 tabs/bookmarks/downloads/browser_profiles/store_proxies）
  db.prepare('DELETE FROM stores WHERE id = ?').run(storeId)

  // 清理 session partition 存储
  try {
    const sess = session.fromPartition(`persist:store_${storeId}`)
    await sess.clearStorageData()
  } catch { /* partition 未创建过则忽略 */ }

  // 清理店铺下载目录
  try {
    rmSync(join(app.getPath('userData'), 'stores', storeId), { recursive: true, force: true })
  } catch { /* ignore */ }

  return true
}

/**
 * 重新排序店铺 - §6.1
 */
export function reorderStores(orderedStoreIds: string[]): boolean {
  const db = getDatabase()
  
  db.transaction(() => {
    const stmt = db.prepare('UPDATE stores SET sort_order = ?, updated_at = ? WHERE id = ?')
    
    orderedStoreIds.forEach((storeId, index) => {
      stmt.run(index, Date.now(), storeId)
    })
  })()
  
  return true
}

/**
 * 设置店铺分组 - §6.1
 */
export function setStoreGroup(storeId: string, groupName: string | null): boolean {
  const db = getDatabase()
  const stmt = db.prepare(`
    UPDATE stores 
    SET group_name = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `)
  
  const info = stmt.run(groupName, Date.now(), storeId)
  return info.changes > 0
}

/**
 * 更新店铺最后活动时间 - §8.2
 */
export function updateStoreLastActive(storeId: string): void {
  const db = getDatabase()
  const stmt = db.prepare(`
    UPDATE stores 
    SET last_active_at = ?, updated_at = ?
    WHERE id = ?
  `)
  
  stmt.run(Date.now(), Date.now(), storeId)
}

/**
 * 更新店铺状态 - §9.1 状态机
 */
export function updateStoreStatus(storeId: string, status: StoreStatus): boolean {
  const db = getDatabase()
  const stmt = db.prepare(`
    UPDATE stores 
    SET status = ?, updated_at = ?
    WHERE id = ?
  `)
  
  const info = stmt.run(status, Date.now(), storeId)
  return info.changes > 0
}
