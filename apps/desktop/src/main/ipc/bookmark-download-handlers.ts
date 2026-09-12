/**
 * 书签和下载相关的 IPC 处理器
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as BookmarkManager from '../browser/bookmark-manager'
import * as DownloadManager from '../browser/download-manager'
import * as StoreManager from '../stores/store-manager'
import { randomUUID } from 'crypto'

function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string): IPCResult {
  return {
    ok: false,
    error: { code, message },
    requestId
  }
}

/**
 * 注册书签和下载相关的 IPC 处理器
 */
export function registerBookmarkAndDownloadHandlers(): void {
  // bookmark:list
  ipcMain.handle(IPC_CHANNELS.BOOKMARK_LIST, async (_event: IpcMainInvokeEvent, input: { storeId?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const bookmarks = BookmarkManager.listBookmarks(input.storeId)
      return success(bookmarks, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // bookmark:entryRoutes —— 平台入口（§16，只读展示，不写库）
  ipcMain.handle(IPC_CHANNELS.BOOKMARK_ENTRY_ROUTES, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()

    try {
      const store = input?.storeId ? StoreManager.getStore(input.storeId) : null
      if (!store) return error(ERROR_CODES.STORE_NOT_FOUND.code, '店铺不存在', requestId)
      return success({ platform: store.platform, routes: BookmarkManager.getEntryRoutes(store.platform) }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // bookmark:create
  ipcMain.handle(IPC_CHANNELS.BOOKMARK_CREATE, async (_event: IpcMainInvokeEvent, input: any): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const bookmark = BookmarkManager.createBookmark(input)
      return success(bookmark, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // bookmark:delete
  ipcMain.handle(IPC_CHANNELS.BOOKMARK_DELETE, async (_event: IpcMainInvokeEvent, input: { bookmarkId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const deleted = BookmarkManager.deleteBookmark(input.bookmarkId)
      return success({ success: deleted }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // download:list
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_LIST, async (_event: IpcMainInvokeEvent, input: { storeId: string, limit?: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const downloads = DownloadManager.listDownloads(input.storeId, input.limit)
      return success(downloads, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // download:showInFolder
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_SHOW_IN_FOLDER, async (_event: IpcMainInvokeEvent, input: { downloadId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const shown = DownloadManager.showDownloadInFolder(input.downloadId)
      return success({ success: shown }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
