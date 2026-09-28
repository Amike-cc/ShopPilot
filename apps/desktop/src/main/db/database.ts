/**
 * 数据库连接管理
 * 使用 better-sqlite3 (§2.1)
 */

import { app } from 'electron'
import { join } from 'path'
import { migrate } from './migrations'
import type Database from 'better-sqlite3'

let db: Database.Database | null = null

/**
 * 获取数据库路径
 */
export function getDatabasePath(): string {
  return join(app.getPath('userData'), 'shopilot.db')
}

/**
 * 初始化数据库连接
 */
export function initDatabase(): Database.Database {
  if (db) {
    return db
  }

  // 动态导入 better-sqlite3 以避免类型错误
  const Database = require('better-sqlite3')
  const dbPath = getDatabasePath()
  
  db = new Database(dbPath) as Database.Database

  // §5 前言：连接级 PRAGMA，必须在事务外执行
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // busy_timeout：默认是 0，意味着**一旦有第二个连接持锁就立刻抛 SQLITE_BUSY**
  // （实测本机 busy_timeout=0）。本项目确实会出现第二个连接：备份/恢复/巡检用只读连接打开
  // 同一个库文件（backup-manager），杀软与同步盘偶尔也会碰一下。表现为随机"保存失败"，
  // 7×24 挂机下极难复现定位（2026-09-28 审查确认）。
  db.pragma('busy_timeout = 5000')
  // synchronous：显式写死 FULL。默认值在 WAL 下历史变过口径，业务库宁可慢一点也别赌默认。
  db.pragma('synchronous = FULL')

  // 执行迁移
  migrate(db)
  
  return db
}

/**
 * 获取数据库实例
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
