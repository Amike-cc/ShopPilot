/**
 * 备份管理器 - §10.2 / §20 / §28
 * 备份用 SQLite Online Backup API（避免复制热 WAL 文件损坏），
 * 记录 SHA-256；恢复前自动创建当前快照，任何失败不覆盖现有数据。
 *
 * 跨机恢复边界（§10.2）：元数据/配置/标签索引可跨机恢复；
 * Chromium 会话由 DPAPI 用户级保护，异机需重登录或会话导出包导入。
 */

import { app } from 'electron'
import { createHash } from 'crypto'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'fs'
import { join } from 'path'
import { getDatabase, closeDatabase, initDatabase, getDatabasePath } from '../db/database'
import { writeAudit } from '../services/audit-logger'

export interface BackupRecord {
  id: string
  filePath: string
  sha256: string
  sizeBytes: number
  createdAt: number
  restoreStatus: string | null
}

function backupsDir(): string {
  const dir = join(app.getPath('userData'), 'backups')
  const { mkdirSync } = require('fs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function mapBackupRow(r: any): BackupRecord {
  return {
    id: r.id, filePath: r.file_path, sha256: r.sha256,
    sizeBytes: r.size_bytes, createdAt: r.created_at,
    restoreStatus: r.restore_status ?? null
  }
}

/**
 * 创建备份（WAL 已 checkpoint 进主文件后再复制，保证一致性）
 */
export async function createBackup(label?: string): Promise<BackupRecord> {
  const db = getDatabase()
  const id = `backup_${randomBytes(10).toString('hex')}`
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = join(backupsDir(), `shopilot-${stamp}${label ? '-' + label : ''}.db`)

  // better-sqlite3 Online Backup API
  await db.backup(filePath)

  // 校验备份可读且通过完整性检查
  const Database = require('better-sqlite3')
  const check = new Database(filePath, { readonly: true })
  const integrity = check.pragma('integrity_check', { simple: true })
  check.close()
  if (integrity !== 'ok') {
    throw new Error('BACKUP_INTEGRITY_FAILED')
  }

  const sha256 = sha256OfFile(filePath)
  const sizeBytes = statSync(filePath).size
  const now = Date.now()

  db.prepare(`
    INSERT INTO backups (id, file_path, sha256, size_bytes, created_at, restore_status)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(id, filePath, sha256, sizeBytes, now)

  writeAudit('backup.create', 'success')
  return getBackup(id)!
}

export function listBackups(): BackupRecord[] {
  return (getDatabase().prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as any[]).map(mapBackupRow)
}

export function getBackup(backupId: string): BackupRecord | null {
  const r = getDatabase().prepare('SELECT * FROM backups WHERE id = ?').get(backupId)
  return r ? mapBackupRow(r) : null
}

/**
 * 恢复备份 - §28：先给当前状态拍快照，校验 SHA-256，失败绝不覆盖现有数据。
 * 恢复后需重启店铺浏览器会话（session 层缓存的 partition 数据不变）。
 */
export async function restoreBackup(backupId: string): Promise<{ success: true; safetyBackupId: string }> {
  const target = getBackup(backupId)
  if (!target) throw new Error('BACKUP_NOT_FOUND')
  if (!existsSync(target.filePath)) throw new Error('BACKUP_CHECKSUM_FAILED')

  // 1) 恢复前强制快照当前状态
  const safety = await createBackup('pre-restore')

  // 2) 校验备份文件哈希与库内记录一致
  const actual = sha256OfFile(target.filePath)
  if (actual !== target.sha256) {
    throw new Error('BACKUP_CHECKSUM_FAILED')
  }

  // 3) 校验备份内部完整性 + schema 版本不高于当前
  const Database = require('better-sqlite3')
  const pre = new Database(target.filePath, { readonly: true })
  const integrity = pre.pragma('integrity_check', { simple: true })
  const backupVersion = (pre.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any)?.v ?? 0
  const currentVersion = (getDatabase().prepare('SELECT MAX(version) v FROM schema_migrations').get() as any)?.v ?? 0
  pre.close()
  if (integrity !== 'ok') throw new Error('BACKUP_CHECKSUM_FAILED')
  if (backupVersion > currentVersion) throw new Error('BACKUP_VERSION_TOO_NEW')

  // 4) 关闭当前库 → WAL 文件清理 → 覆盖 → 重开（迁移幂等）
  const dbPath = getDatabasePath()
  closeDatabase()
  try {
    copyFileSync(target.filePath, dbPath)
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(dbPath + ext)) require('fs').rmSync(dbPath + ext, { force: true })
    }
    initDatabase()
  } catch (err) {
    // 恢复失败 → 用刚才的安全快照回滚，保证现有数据不被破坏
    closeDatabase()
    copyFileSync(safety.filePath, dbPath)
    initDatabase()
    throw err
  }

  // 5) 备份文件是在"登记自身元数据之前"拍下的 → 恢复后 backups 表缺少目标行；
  //    连同安全快照一起在恢复后的库中补齐登记（§28 可回退要求）
  const ndb = getDatabase()
  const ensureRow = (id: string, filePath: string, createdAt: number) => {
    if (!ndb.prepare('SELECT id FROM backups WHERE id = ?').get(id)) {
      ndb.prepare(`
        INSERT INTO backups (id, file_path, sha256, size_bytes, created_at, restore_status)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(id, filePath, sha256OfFile(filePath), statSync(filePath).size, createdAt)
    }
  }
  ensureRow(target.id, target.filePath, target.createdAt)
  ensureRow(safety.id, safety.filePath, safety.createdAt)

  ndb.prepare("UPDATE backups SET restore_status = 'restored' WHERE id = ?").run(backupId)
  writeAudit('backup.restore', 'success')
  return { success: true, safetyBackupId: safety.id }
}

/** 保留策略：最近 7 个 + 当前引用（§28 简化版，元数据层） */
export function pruneBackups(keep = 7): number {
  const db = getDatabase()
  const stale = db.prepare(
    'SELECT id, file_path FROM backups ORDER BY created_at DESC LIMIT -1 OFFSET ?'
  ).all(keep) as any[]
  for (const row of stale) {
    try { if (existsSync(row.file_path)) require('fs').rmSync(row.file_path, { force: true }) } catch { /* ignore */ }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id)
  }
  return stale.length
}

// writeFileSync 引用保留（后续加密导出用）
void writeFileSync
void app
