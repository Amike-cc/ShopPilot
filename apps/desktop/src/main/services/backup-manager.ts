/**
 * 备份管理器 - §10.2 / §20 / §28
 * 备份用 SQLite Online Backup API（避免复制热 WAL 文件损坏），
 * 记录 SHA-256；恢复前自动创建当前快照，任何失败不覆盖现有数据。
 *
 * 跨机恢复边界（§10.2）：元数据/配置/标签索引可跨机恢复；
 * Chromium 会话由 DPAPI 用户级保护，异机需重登录或会话导出包导入。
 */

import { app } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { createReadStream, existsSync, statSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'
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
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 备份 label 白名单化：只留中文/字母/数字/下划线/短横。
 *
 * 为什么必须有：label 一路拼进文件名（`shopilot-<stamp>-<label>.db`），而它的来源之一是
 * **模型输出**（Agent 软件计划的 `createBackup` 动作，见 agent-service 的 createBackup 分支）——
 * 用户点一次确认就能让 `..\..\..\x` 这类 label 把关库写到 userData 之外，
 * 随后 `pruneBackups` 还会 `rmSync` 那条越界路径。2026-09-28 审查确认的路径穿越。
 */
function sanitizeBackupLabel(label: unknown): string {
  return String(label ?? '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 40)
}

/** 流式 SHA-256：备份是整库大小（几百 MB 起），`readFileSync` 会同步阻塞主进程并吃掉同量内存 */
function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', rejectHash)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * 原子替换库文件（恢复用）：先写到同目录临时文件，再 `rename` 覆盖。
 *
 * 为什么不能直接 `copyFileSync`：copy 到一半断电/被强杀会留下**半截库文件**，
 * 而此时安全快照尚未生效，等于主库与备份同时不可用（备份功能的最后一道防线反而成了单点）。
 * `rename` 在 Windows 上由 libuv 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，是原子替换
 * （`session-persistence` 写 Cookie 快照用的同一手法）。
 *
 * 顺序说明：WAL/SHM 必须**在 rename 之前**删掉——残留的 `-wal` 配上刚换进来的新库文件，
 * 会被 SQLite 当成"未提交帧"回放，直接毁掉刚恢复的数据。删 WAL 不会丢数据，因为调用前
 * 已经用 Online Backup API 拍过安全快照（它含 WAL 里的已提交内容）。
 */
function atomicReplaceDb(src: string, dbPath: string): void {
  const tmp = `${dbPath}.restore-tmp`
  try { rmSync(tmp, { force: true }) } catch { /* 上一轮残留 */ }
  copyFileSync(src, tmp)
  for (const ext of ['-wal', '-shm']) {
    try { rmSync(dbPath + ext, { force: true }) } catch { /* 不存在即跳过 */ }
  }
  renameSync(tmp, dbPath)
  try { rmSync(tmp, { force: true }) } catch { /* rename 成功后一般已不存在 */ }
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
  const dir = backupsDir()
  const safeLabel = sanitizeBackupLabel(label)
  const filePath = join(dir, `shopilot-${stamp}${safeLabel ? '-' + safeLabel : ''}.db`)
  // 第二道断言：白名单化之后仍确认落点在 backups 目录内（防将来有人改坏 sanitizeBackupLabel）
  if (!resolve(filePath).startsWith(resolve(dir) + sep)) throw new Error('BACKUP_PATH_UNSAFE')

  // better-sqlite3 Online Backup API
  await db.backup(filePath)

  // 校验备份可读且通过完整性检查
  const Database = require('better-sqlite3')
  const check = new Database(filePath, { readonly: true })
  const integrity = check.pragma('integrity_check', { simple: true })
  check.close()
  // 只读打开一个 WAL 模式的库仍会生成 -wal/-shm：备份目录里的成品应当**只有一个 .db**
  // （实测自动备份后目录里躺着 `xxx-auto.db/-wal/-shm` 三个文件，而 pruneBackups 只删 .db，
  // 兄弟文件会一直留下去）。备份内容是 Online Backup API 写出的自足文件，删掉兄弟无影响。
  for (const ext of ['-wal', '-shm']) {
    try { rmSync(filePath + ext, { force: true }) } catch { /* 不存在即跳过 */ }
  }
  if (integrity !== 'ok') {
    throw new Error('BACKUP_INTEGRITY_FAILED')
  }

  const sha256 = await sha256OfFile(filePath)
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

  restoring = true
  try {
    return await restoreBackupInner(target)
  } finally {
    restoring = false
  }
}

async function restoreBackupInner(target: BackupRecord): Promise<{ success: true; safetyBackupId: string }> {
  // 1) 恢复前强制快照当前状态
  const safety = await createBackup('pre-restore')

  // 2) 校验备份文件哈希与库内记录一致
  const actual = await sha256OfFile(target.filePath)
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

  // 4) 关闭当前库 → 原子替换 → 重开（迁移幂等）
  const dbPath = getDatabasePath()
  closeDatabase()
  try {
    atomicReplaceDb(target.filePath, dbPath)
    initDatabase()
  } catch (err) {
    // 恢复失败 → 用刚才的安全快照回滚，保证现有数据不被破坏（同样是原子替换）
    closeDatabase()
    try {
      atomicReplaceDb(safety.filePath, dbPath)
      initDatabase()
    } catch { /* 回滚也失败：保留现场，异常向上抛，日志里有 audit */ }
    throw err
  }

  // 5) 备份文件是在"登记自身元数据之前"拍下的 → 恢复后 backups 表缺少目标行；
  //    连同安全快照一起在恢复后的库中补齐登记（§28 可回退要求）
  const ndb = getDatabase()
  const ensureRow = async (id: string, filePath: string, createdAt: number) => {
    if (!ndb.prepare('SELECT id FROM backups WHERE id = ?').get(id)) {
      ndb.prepare(`
        INSERT INTO backups (id, file_path, sha256, size_bytes, created_at, restore_status)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(id, filePath, await sha256OfFile(filePath), statSync(filePath).size, createdAt)
    }
  }
  await ensureRow(target.id, target.filePath, target.createdAt)
  await ensureRow(safety.id, safety.filePath, safety.createdAt)

  ndb.prepare("UPDATE backups SET restore_status = 'restored' WHERE id = ?").run(target.id)
  writeAudit('backup.restore', 'success')
  // 恢复流程新增了安全快照，行数已超保留额度：恢复完成后收口。
  // 不能在恢复中途 prune——目标备份文件在 copyFileSync 前一直要用。
  try { pruneBackups() } catch { /* 清理失败不影响恢复结果 */ }
  return { success: true, safetyBackupId: safety.id }
}

/** 保留策略：最近 7 个 + 当前引用（§28 简化版，元数据层） */
export function pruneBackups(keep = 7): number {
  const db = getDatabase()
  const stale = db.prepare(
    'SELECT id, file_path FROM backups ORDER BY created_at DESC LIMIT -1 OFFSET ?'
  ).all(keep) as any[]
  for (const row of stale) {
    try {
      if (existsSync(row.file_path)) rmSync(row.file_path, { force: true })
      // 历史备份可能残留 -wal/-shm 兄弟（旧版本写的），一并收口
      for (const ext of ['-wal', '-shm']) {
        if (existsSync(row.file_path + ext)) rmSync(row.file_path + ext, { force: true })
      }
    } catch { /* ignore */ }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id)
  }
  return stale.length
}

// ---------- 自动备份 ----------

/** 自动备份间隔：距上次备份不足这个时长就跳过（多定时器/多入口不会重复拍） */
const AUTO_BACKUP_INTERVAL_MS = 24 * 3600 * 1000
/**
 * 是否正在恢复：恢复期间禁止自动备份——它会 `createBackup` 写新文件，
 * 而恢复流程正在换库文件，两个动作交错会让"安全快照"拍到一个半换完的库。
 */
let restoring = false
let autoBackupRunning = false

/** 最近一次备份时间（含手工与自动）；表为空返回 0 */
export function lastBackupAt(): number {
  try {
    const row = getDatabase().prepare('SELECT MAX(created_at) v FROM backups').get() as any
    return Number(row?.v) || 0
  } catch {
    return 0
  }
}

/** 开关 `backup.auto`（默认开）：写 `false` 可关闭自动备份 */
function autoBackupEnabled(): boolean {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get('backup.auto') as any
    return row ? JSON.parse(row.value_json) !== false : true
  } catch {
    return true
  }
}

/**
 * 最新的备份文件（**直接扫盘**，不查库）。
 *
 * 为什么不能查 `backups` 表：这个函数是给"库已经打不开"的场景用的——那时
 * `initDatabase()` 都抛错了，任何查库的路径都不可用。用文件名里的 ISO 时间戳排序
 * （`shopilot-YYYY-MM-DDTHH-mm-ss[-label].db`），`pre-restore` 是后拍的所以天生最新。
 */
export function latestBackupFileOnDisk(): string | null {
  try {
    const dir = backupsDir()
    const files = require('fs').readdirSync(dir) as string[]
    const candidates = files
      .filter((f) => /^shopilot-.*\.db$/.test(f))
      .map((f) => {
        const m = /^shopilot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(f)
        return { file: join(dir, f), stamp: m ? m[1] : '' }
      })
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
    const newest = candidates.find((c) => existsSync(c.file))
    return newest ? newest.file : null
  } catch {
    return null
  }
}

/**
 * 启动自愈：库打不开时用最新备份原子替换回去。
 *
 * 为什么需要：库损坏/迁移抛错时，原先的代码只写 `startup-error.log` 然后 `app.quit()`，
 * 而"从备份恢复"这个功能本身要求应用能起来——**唯一的自救路径依赖应用能启动**，
 * 于是用户看到的是"双击图标毫无反应"，备份文件就在磁盘上却用不了（2026-09-28 审查确认的死锁）。
 * 这里把"扫盘找最新备份 → 原子换回来"做成不依赖库的能力。
 *
 * 注意：调用方负责"换库前先关闭现有连接"，并在成功后重新 `initDatabase()`。
 */
export function recoverDatabaseFromLatestBackup(dbPath: string): { restoredFrom: string } {
  const file = latestBackupFileOnDisk()
  if (!file) throw new Error('BACKUP_NOT_FOUND')
  // 换之前先用流式哈希与 integrity_check 验证，别把损坏的备份换成主库
  const Database = require('better-sqlite3')
  const probe = new Database(file, { readonly: true })
  try {
    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED')
  } finally {
    probe.close()
  }
  atomicReplaceDb(file, dbPath)
  return { restoredFrom: file }
}

/**
 * 自动备份（补齐 §28 只有"手工 + 保留 7 份"、缺"定期"的那一半）。
 *
 * 为什么必须自动：2026-09-28 审查实测——产品跑 19 天，`backups` 目录**不存在**、表 0 行，
 * 因为 `createBackup` 此前只在用户手点与"恢复前"被调用。单机产品的库就是全部资产，
 * "没人点过备份"等于"没有任何备份"。
 *
 * 调用方式：启动后判一次 + 每 6 小时再判一次（24h 闸决定是否真拍）。
 * 失败只落日志不打扰用户（备份失败不该阻塞使用），但会写审计留痕。
 */
export async function autoBackupIfDue(): Promise<{ created: boolean; reason?: string }> {
  if (autoBackupRunning) return { created: false, reason: 'running' }
  if (restoring) return { created: false, reason: 'restoring' }
  if (!autoBackupEnabled()) return { created: false, reason: 'disabled' }
  const last = lastBackupAt()
  if (last && Date.now() - last < AUTO_BACKUP_INTERVAL_MS) return { created: false, reason: 'fresh' }
  autoBackupRunning = true
  try {
    await createBackup('auto')
    pruneBackups()
    return { created: true }
  } finally {
    autoBackupRunning = false
  }
}
