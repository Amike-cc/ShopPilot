/**
 * 下载管理器
 * §5.9 downloads 表
 */

import { getDatabase } from '../db/database'
import { BrowserWindow, shell } from 'electron'
import { existsSync } from 'fs'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'

/** 店铺级进行中下载计数。数据库状态用于历史展示，内存计数用于生命周期回收门禁。 */
const activeDownloadsByStore = new Map<string, number>()
const activeDownloadStoreById = new Map<string, string>()

function addActiveDownload(storeId: string): void {
  activeDownloadsByStore.set(storeId, (activeDownloadsByStore.get(storeId) || 0) + 1)
}

function removeActiveDownload(storeId: string): void {
  const left = (activeDownloadsByStore.get(storeId) || 0) - 1
  if (left > 0) activeDownloadsByStore.set(storeId, left)
  else activeDownloadsByStore.delete(storeId)
}

function finishActiveDownload(downloadId: string): void {
  const storeId = activeDownloadStoreById.get(downloadId)
  if (!storeId) return
  activeDownloadStoreById.delete(downloadId)
  removeActiveDownload(storeId)
}

/** 冷休眠前使用：下载记录刚写入但尚未收到 done 事件时，不能销毁页面 guest。 */
export function isStoreDownloadActive(storeId: string): boolean {
  return (activeDownloadsByStore.get(storeId) || 0) > 0
}

/** 诊断与测试使用，不暴露下载内容或文件路径。 */
export function getActiveDownloadStoreIds(): string[] {
  return Array.from(activeDownloadsByStore.keys()).sort()
}

/**
 * 把下载状态推给渲染层。
 *
 * 为什么放在这里：`will-download` 挂在 session-manager 上，而 session-manager 是
 * window-manager 的依赖方（反向 import 会成环）。download-manager 是叶子模块，
 * 直接向所有窗口广播即可（本项目只有一个主窗口，但用 getAllWindows 更稳）。
 *
 * 2026-09-28 审查确认：此前进度与创建事件**主进程从不发送**，而渲染层早已在监听
 * `BROWSER_DOWNLOAD_PROGRESS`（workspace.ts:198）→ 下载面板永不实时更新，
 * 完成/中断对用户不可见，只能手动刷新。
 */
export function emitDownloadCreated(payload: { id: string; storeId: string; fileName: string; filePath: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(EVENT_CHANNELS.BROWSER_DOWNLOAD_CREATED, payload) } catch { /* 窗口正在销毁 */ }
  }
}

export function emitDownloadProgress(payload: { id: string; storeId: string; state: string; receivedBytes: number; totalBytes: number }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(EVENT_CHANNELS.BROWSER_DOWNLOAD_PROGRESS, payload) } catch { /* 窗口正在销毁 */ }
  }
}

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
 * @returns 'shown' | 'missing' | 'not-found'：文件已被移动/删除时如实回报，
 *   不能像以前那样"只要库里有记录就返回 true"——用户点「打开所在文件夹」会毫无反应且没有解释。
 */
export function showDownloadInFolder(downloadId: string): 'shown' | 'missing' | 'not-found' {
  const db = getDatabase()
  
  const download = db.prepare('SELECT file_path FROM downloads WHERE id = ?').get(downloadId) as { file_path: string } | undefined
  
  if (!download || !download.file_path) {
    return 'not-found'
  }
  if (!existsSync(download.file_path)) return 'missing'
  
  // 使用 shell.showItemInFolder 在文件管理器中显示
  shell.showItemInFolder(download.file_path)
  return 'shown'
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
  addActiveDownload(storeId)
  activeDownloadStoreById.set(downloadId, storeId)
  
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
  // Electron 的 updated 事件可能先报 interrupted，随后 done 再报 cancelled；
  // 计数只允许从正数减到零，重复终态不会造成负数。
  if (state !== 'progressing' && state !== 'in_progress') finishActiveDownload(downloadId)
}

/**
 * 删除下载记录（不删除文件）
 */
export function deleteDownloadRecord(downloadId: string): boolean {
  const db = getDatabase()
  const row = db.prepare('SELECT store_id, state FROM downloads WHERE id = ?').get(downloadId) as { store_id?: string; state?: string } | undefined
  const info = db.prepare('DELETE FROM downloads WHERE id = ?').run(downloadId)
  if (info.changes > 0 && row) finishActiveDownload(downloadId)
  return info.changes > 0
}
