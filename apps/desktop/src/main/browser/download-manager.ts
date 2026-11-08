/**
 * 下载管理器
 * §5.9 downloads 表
 */

import { getDatabase } from '../db/database'
import { BrowserWindow, shell, type DownloadItem } from 'electron'
import { existsSync } from 'fs'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { isTerminalDownloadState } from '@shared/browser-tools'

/** 店铺级进行中下载计数。数据库状态用于历史展示，内存计数用于生命周期回收门禁。 */
const activeDownloadsByStore = new Map<string, number>()
const activeDownloadStoreById = new Map<string, string>()
/**
 * 进行中下载的 DownloadItem 句柄（2026-11-08）。
 *
 * 为什么必须留引用：`pause()/resume()/cancel()` 都是 DownloadItem 上的方法，而 will-download
 * 回调结束后就没有别的入口能拿到它。只在内存里存、终态即删——重启后旧记录没有句柄，
 * 界面据此只显示"打开文件夹"，不会给出点了没反应的控制按钮。
 */
const activeItems = new Map<string, DownloadItem>()

function addActiveDownload(storeId: string): void {
  activeDownloadsByStore.set(storeId, (activeDownloadsByStore.get(storeId) || 0) + 1)
}

function removeActiveDownload(storeId: string): void {
  const left = (activeDownloadsByStore.get(storeId) || 0) - 1
  if (left > 0) activeDownloadsByStore.set(storeId, left)
  else activeDownloadsByStore.delete(storeId)
}

function finishActiveDownload(downloadId: string): void {
  activeItems.delete(downloadId)
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
  const boundedLimit = limit === undefined ? 50 : Math.min(200, Math.max(1, Math.floor(Number(limit))))
  const query = `
    SELECT * FROM downloads 
    WHERE store_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `
  
  return (db.prepare(query).all(storeId, Number.isFinite(boundedLimit) ? boundedLimit : 50) as any[]).map((r: any) => ({
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
  } else if (sizeBytes === undefined) {
    // 没带体积就只改状态：暂停/中断这类调用不该把已写入的 size_bytes 洗成 NULL
    //（两个 updated 分支都不传 size，此前会把体积一路擦掉）
    db.prepare('UPDATE downloads SET state = ? WHERE id = ?').run(state, downloadId)
  } else {
    db.prepare(`
      UPDATE downloads 
      SET state = ?, size_bytes = ?
      WHERE id = ?
    `).run(state, sizeBytes || null, downloadId)
  }
  // Electron 的 updated 事件可能先报 interrupted，随后 done 再报 cancelled；
  // 计数只允许从正数减到零，重复终态不会造成负数。
  // 暂停**不是**终态（2026-11-08）：暂停中的下载仍占着页面与句柄，不能释放，
  // 否则用户点"继续"时句柄已经被回收，只能重下一遍。
  if (isTerminalDownloadState(state)) finishActiveDownload(downloadId)
}

/**
 * 登记进行中下载的句柄。will-download 里在 recordDownload 之后调用一次。
 * 只存内存不落库：重启后旧记录没有句柄，控制按钮会按"进行中"的陈旧状态给出，
 * 所以界面另外用 ACTIVE_DOWNLOAD_STATES 判定，并在主进程如实回 not-active。
 */
export function registerDownloadItem(downloadId: string, item: DownloadItem): void {
  activeItems.set(downloadId, item)
}

export type DownloadControlResult =
  | 'paused'
  | 'already-paused'
  | 'resumed'
  | 'not-paused'
  | 'cannot-resume'
  | 'cancelled'
  | 'not-active'

/**
 * 取"还活着"的下载句柄。
 *
 * 已经到终态的条目即便还留在 Map 里也不能再操控：DownloadItem 完成后调用
 * pause/resume 无效甚至抛错，界面会表现为"点了没反应"——那比没有按钮更糟。
 */
function liveDownloadItem(downloadId: string): DownloadItem | null {
  const item = activeItems.get(downloadId)
  if (!item) return null
  try {
    // 暂停中的条目 getState() 仍是 progressing，但保守起见把 isPaused 也算"活着"，
    // 否则某些版本上状态字段一变，暂停中的下载就再也点不了"继续"。
    if (item.getState() !== 'progressing' && !item.isPaused()) {
      activeItems.delete(downloadId)
      return null
    }
  } catch {
    activeItems.delete(downloadId)
    return null
  }
  return item
}

/** DownloadItem 的 isPaused 在条目已销毁时会抛错，探测失败按"没暂停"处理。 */
export function isItemPaused(item: DownloadItem): boolean {
  try {
    return item.isPaused()
  } catch {
    return false
  }
}

function safeBytes(read: () => number): number {
  try {
    const value = read()
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function emitControlProgress(downloadId: string, state: 'paused' | 'progressing', item: DownloadItem): void {
  emitDownloadProgress({
    id: downloadId,
    storeId: activeDownloadStoreById.get(downloadId) || '',
    state,
    receivedBytes: safeBytes(() => item.getReceivedBytes()),
    totalBytes: safeBytes(() => item.getTotalBytes())
  })
}

/** 暂停：只暂停传输，不取消、不丢已下载分片。 */
export function pauseDownload(downloadId: string): DownloadControlResult {
  const item = liveDownloadItem(downloadId)
  if (!item) return 'not-active'
  try {
    if (item.isPaused()) return 'already-paused'
    item.pause()
  } catch {
    return 'not-active'
  }
  updateDownloadState(downloadId, 'paused')
  emitControlProgress(downloadId, 'paused', item)
  return 'paused'
}

/**
 * 继续。
 * `canResume()` 为 false 表示服务端不支持 Range（或分片已不可用），此时 Electron 的
 * resume() 只会从零开始或者无效——如实回 cannot-resume，由界面告诉用户"这条只能重下"。
 */
export function resumeDownload(downloadId: string): DownloadControlResult {
  const item = liveDownloadItem(downloadId)
  if (!item) return 'not-active'
  try {
    if (!item.isPaused()) return 'not-paused'
    if (!item.canResume()) return 'cannot-resume'
    item.resume()
  } catch {
    return 'not-active'
  }
  updateDownloadState(downloadId, 'progressing')
  emitControlProgress(downloadId, 'progressing', item)
  return 'resumed'
}

/** 取消：真正的取消由 done 事件收尾（写 cancelled + 通知界面），这里不重复写库。 */
export function cancelDownload(downloadId: string): DownloadControlResult {
  const item = liveDownloadItem(downloadId)
  if (!item) return 'not-active'
  try {
    item.cancel()
  } catch {
    return 'not-active'
  }
  return 'cancelled'
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
