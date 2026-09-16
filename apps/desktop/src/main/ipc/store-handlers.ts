/**
 * IPC 处理器 - 店铺管理
 * §6.1 店铺 IPC 接口
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import {
  storeCreateSchema,
  storeGroupSchema,
  storeIdInputSchema,
  storeReorderSchema,
  storeUpdateSchema
} from '@shared/schemas/store'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as StoreManager from '../stores/store-manager'
import { randomUUID } from 'crypto'

/**
 * 生成请求 ID
 */
function generateRequestId(): string {
  return randomUUID()
}

/**
 * 包装成功响应
 */
function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

/**
 * 包装错误响应
 */
function error(code: string, message: string, requestId: string, details?: any): IPCResult {
  return {
    ok: false,
    error: { code, message, details },
    requestId
  }
}

function invalidInput(requestId: string, issues: Array<{ path: PropertyKey[]; message: string }>): IPCResult {
  return error(
    ERROR_CODES.INVALID_ARGUMENT.code,
    ERROR_CODES.INVALID_ARGUMENT.message,
    requestId,
    issues.slice(0, 8).map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message }))
  )
}

/**
 * 注册所有店铺相关的 IPC 处理器
 */
export function registerStoreHandlers(): void {
  // store:list
  ipcMain.handle(IPC_CHANNELS.STORE_LIST, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const stores = StoreManager.listStores()
      return success(stores, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:get
  ipcMain.handle(IPC_CHANNELS.STORE_GET, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const store = StoreManager.getStore(parsed.data.storeId)
      
      if (!store) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return success(store, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:create
  ipcMain.handle(IPC_CHANNELS.STORE_CREATE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeCreateSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const store = StoreManager.createStore(parsed.data)
      
      // TODO: 创建 browser_profile（§8.1 步骤 3）
      // TODO: 如果配置代理，执行连接测试（§8.1 步骤 5）
      
      return success(store, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:update
  ipcMain.handle(IPC_CHANNELS.STORE_UPDATE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeUpdateSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const store = StoreManager.updateStore(parsed.data)
      
      if (!store) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return success(store, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:archive
  ipcMain.handle(IPC_CHANNELS.STORE_ARCHIVE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const success = StoreManager.archiveStore(parsed.data.storeId)
      
      if (!success) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:restore
  ipcMain.handle(IPC_CHANNELS.STORE_RESTORE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const success = StoreManager.restoreStore(parsed.data.storeId)
      
      if (!success) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:deletePermanent
  ipcMain.handle(IPC_CHANNELS.STORE_DELETE_PERMANENT, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      // TODO: 清理 profile、下载和备份引用
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const success = StoreManager.deleteStorePermanent(parsed.data.storeId)
      
      if (!success) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:trashList - 回收站列表（软删除店铺）
  ipcMain.handle(IPC_CHANNELS.STORE_TRASH_LIST, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(StoreManager.listTrashStores(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // store:purge - 彻底删除（回收站内，二次确认后）
  ipcMain.handle(IPC_CHANNELS.STORE_PURGE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const ok = await StoreManager.purgeStore(parsed.data.storeId)
      if (!ok) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, '回收站中未找到该店铺', requestId)
      }
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // store:reorder
  ipcMain.handle(IPC_CHANNELS.STORE_REORDER, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeReorderSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      StoreManager.reorderStores(parsed.data.orderedStoreIds)
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:setGroup
  ipcMain.handle(IPC_CHANNELS.STORE_SET_GROUP, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeGroupSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const success = StoreManager.setStoreGroup(parsed.data.storeId, parsed.data.groupName)
      
      if (!success) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
