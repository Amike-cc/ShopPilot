/**
 * 下载管理器
 * §5.9 downloads 表
 */

import { getDatabase } from '../db/database'
import { shell } from 'electron'

export interface Download {
  id: string
  storeId: string
  pageUrl: string | null
  fileName: string
  filePath: string
  sizeBytes: number | null
  state: string
  createdAt: number
  completedAt: number | null
}

/**
 * 列出下载记录 - §6.2（行映射为 camelCase）
 */
export function listDownloads(storeId: string, limit?: number): Download[] {
  const db = getDatabase()
  
  const query = `
    SELECT * FROM downloads 
    WHERE store_id = ?
    ORDER BY created_at DESC
    ${limit ? `LIMIT ${Number(limit) || 20}` : 'LIMIT 50'}
  `
  
  return (db.prepare(query).all(storeId) as any[]).map((r: any) => ({
    id: r.id,
    storeId: r.store_id,
    pageUrl: r.page_url ?? null,
    fileName: r.file_name,
    filePath: r.file_path,
    sizeBytes: r.size_bytes ?? null,
    state: r.state,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null
  }))
}

/**
 * 在文件夹中显示下载文件 - §6.2
 */
export function showDownloadInFolder(downloadId: string): boolean {
  const db = getDatabase()
  
  const download = db.prepare('SELECT file_path FROM downloads WHERE id = ?').get(downloadId)
  
  if (!download || !download.file_path) {
    return false
  }
  
  // 使用 shell.showItemInFolder 在文件管理器中显示
  shell.showItemInFolder(download.file_path)
  return true
}

/**
 * 记录下载
 * 这个函数会被 session.on('will-download') 事件调用
 */
export function recordDownload(
  storeId: string,
  fileName: string,
  filePath: string,
  pageUrl?: string
): string {
  const db = getDatabase()
  const now = Date.now()
  const downloadId = `download_${now}_${Math.random().toString(36).substring(7)}`
  
  db.prepare(`
    INSERT INTO downloads (id, store_id, page_url, file_name, file_path, size_bytes, state, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, 'in_progress', ?)
  `).run(downloadId, storeId, pageUrl || null, fileName, filePath, now)
  
  return downloadId
}

/**
 * 更新下载状态
 */
export function updateDownloadState(
  downloadId: string,
  state: string,
  sizeBytes?: number
): void {
  const db = getDatabase()
  const now = Date.now()
  
  if (state === 'completed') {
    db.prepare(`
      UPDATE downloads 
      SET state = ?, size_bytes = ?, completed_at = ?
      WHERE id = ?
    `).run(state, sizeBytes || null, now, downloadId)
  } else {
    db.prepare(`
      UPDATE downloads 
      SET state = ?, size_bytes = ?
      WHERE id = ?
    `).run(state, sizeBytes || null, downloadId)
  }
}

/**
 * 删除下载记录（不删除文件）
 */
export function deleteDownloadRecord(downloadId: string): boolean {
  const db = getDatabase()
  const info = db.prepare('DELETE FROM downloads WHERE id = ?').run(downloadId)
  return info.changes > 0
}
