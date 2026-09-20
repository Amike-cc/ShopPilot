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
