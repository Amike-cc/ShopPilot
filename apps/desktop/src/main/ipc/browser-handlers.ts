/**
 * 浏览器相关的 IPC 处理器
 * §6.2 浏览器和标签页接口
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as WindowManager from '../browser/window-manager'
import { clearStoreData } from '../browser/session-manager'
import { randomUUID } from 'crypto'

function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string, details?: any): IPCResult {
  return {
    ok: false,
    error: { code, message, details },
    requestId
  }
}

/**
 * 注册所有浏览器相关的 IPC 处理器
 */
export function registerBrowserHandlers(): void {
  // browser:open
  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.openStoreBrowser(input.storeId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:close
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeStoreBrowser(input.storeId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:create
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CREATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, url?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const tabId = WindowManager.createTab(input.storeId, input.url)
      return success({ tabId }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:activate
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_ACTIVATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.activateTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:close
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CLOSE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.closeTab(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:setPinned
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_SET_PINNED, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, pinned: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.setTabPinned(input.storeId, input.tabId, input.pinned)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:tab:reorder
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_REORDER, async (_event: IpcMainInvokeEvent, input: { storeId: string, orderedTabIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.reorderTabs(input.storeId, input.orderedTabIds)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:navigate
  ipcMain.handle(IPC_CHANNELS.BROWSER_NAVIGATE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, url: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      WindowManager.navigateTab(input.storeId, input.tabId, input.url)
      return success({ success: true }, requestId)
    } catch (err: any) {
      if (err.message.includes('Navigation blocked')) {
        return error(ERROR_CODES.NAVIGATION_BLOCKED.code, ERROR_CODES.NAVIGATION_BLOCKED.message, requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:clearData
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (_event: IpcMainInvokeEvent, input: { storeId: string, types: string[], origin?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      await clearStoreData(input.storeId, input.types, input.origin)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // browser:capture - 真实截图（返回 base64 PNG/JPEG）
  ipcMain.handle(IPC_CHANNELS.BROWSER_CAPTURE, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, format: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const dataUrl = await WindowManager.captureTab(input.storeId, input.tabId, input.format || 'png')
      return success({ format: input.format || 'png', data: dataUrl }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:tab:list - UI 读取当前店铺标签页
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_LIST, async (_event: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const tabs = WindowManager.getStoreTabs(input.storeId).map(t => ({
        id: t.id, url: t.url, title: t.title, isPinned: t.isPinned, orderIndex: t.orderIndex
      }))
      return success({ tabs }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:openWindow - §14 独立窗口逃生入口
  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN_WINDOW, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.openStandaloneWindow(input.storeId, input.tabId)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:display - 切换显示的店铺（§8.2）
  ipcMain.handle(IPC_CHANNELS.BROWSER_DISPLAY, async (_event: IpcMainInvokeEvent, input: { storeId: string | null }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.displayStore(input.storeId)
      return success({ success: true, displayedStoreId: WindowManager.getDisplayedStoreId() }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:setViewport - 渲染层上报 BrowserViewport 区域
  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_VIEWPORT, async (_event: IpcMainInvokeEvent, input: { x: number, y: number, width: number, height: number }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.setViewportBounds({ x: input.x, y: input.y, width: input.width, height: input.height })
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:setViewsObscured - 渲染层弹层遮挡：摘除/恢复原生视图挂载
  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_VIEWS_OBSCURED, async (_event: IpcMainInvokeEvent, input: { obscured: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.setBrowserViewsObscured(input?.obscured === true)
      return success({ obscured: input?.obscured === true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // browser:tab:control - 地址栏 前进/后退/重载
  ipcMain.handle(IPC_CHANNELS.BROWSER_TAB_CONTROL, async (_event: IpcMainInvokeEvent, input: { storeId: string, tabId: string, action: 'back' | 'forward' | 'reload' }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      WindowManager.tabNavigationControl(input.storeId, input.tabId, input.action)
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
