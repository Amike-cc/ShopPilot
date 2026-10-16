/**
 * 书签和下载相关的 IPC 处理器
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as BookmarkManager from '../browser/bookmark-manager'
import * as DownloadManager from '../browser/download-manager'
import * as StoreManager from '../stores/store-manager'
import { randomUUID } from 'crypto'
import { ipcOk as success, ipcFail as error } from './envelope'
import { z } from 'zod'

function generateRequestId(): string {
  return randomUUID()
}
const downloadListInputSchema = z.object({ storeId: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).strict()

/**
 * 注册书签和下载相关的 IPC 处理器
 */
const handle = familyHandle('书签与下载')

export function registerBookmarkAndDownloadHandlers(): void {
  // bookmark:list
  handle(IPC_CHANNELS.BOOKMARK_LIST, async (_event: IpcMainInvokeEvent, input: { storeId?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const bookmarks = BookmarkManager.listBookmarks(input.storeId)
      return success(bookmarks, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // bookmark:entryRoutes —— 平台入口（§16，只读展示，不写库）
  handle(IPC_CHANNELS.BOOKMARK_ENTRY_ROUTES, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.BOOKMARK_CREATE, async (_event: IpcMainInvokeEvent, input: any): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const bookmark = BookmarkManager.createBookmark(input)
      return success(bookmark, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // bookmark:delete
  handle(IPC_CHANNELS.BOOKMARK_DELETE, async (_event: IpcMainInvokeEvent, input: { bookmarkId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const deleted = BookmarkManager.deleteBookmark(input.bookmarkId)
      return success({ success: deleted }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // download:list
  handle(IPC_CHANNELS.DOWNLOAD_LIST, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const parsed = downloadListInputSchema.safeParse(input)
    if (!parsed.success) return error(ERROR_CODES.INVALID_ARGUMENT.code, '下载查询参数不合法', requestId)
    try {
      const downloads = DownloadManager.listDownloads(parsed.data.storeId, parsed.data.limit)
      return success(downloads, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // download:showInFolder
  handle(IPC_CHANNELS.DOWNLOAD_SHOW_IN_FOLDER, async (_event: IpcMainInvokeEvent, input: { downloadId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      // 三种结果如实回报：missing = 文件已被移动/删除（以前一律返回 success:true，
      // 用户点「打开所在文件夹」没反应也没有解释）
      const result = DownloadManager.showDownloadInFolder(input.downloadId)
      return success({ success: result === 'shown', result }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
