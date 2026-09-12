/**
 * 代理 / 备份 / 会话状态 IPC 处理器 - §6.3 / §6.5
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as ProxyManager from '../browser/proxy-manager'
import * as BackupManager from '../services/backup-manager'
import { getOpenStoreIds, getStoreTabs, emitToRenderer } from '../browser/window-manager'
import { getProxyAuthInjection } from '../browser/session-manager'
import { randomUUID } from 'crypto'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult { return { ok: false, error: { code, message }, requestId } }

function proxyError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('PROXY_INVALID')) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

function backupError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('BACKUP_CHECKSUM_FAILED')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, ERROR_CODES.BACKUP_CHECKSUM_FAILED.message, requestId)
  if (msg.includes('BACKUP_NOT_FOUND')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份不存在或文件缺失', requestId)
  if (msg.includes('BACKUP_VERSION_TOO_NEW')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份来自更高版本，请先升级应用', requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

export function registerProxyAndBackupHandlers(): void {
  // ---------- 代理 §6.3 ----------
  ipcMain.handle(IPC_CHANNELS.PROXY_TEST, async (_e: IpcMainInvokeEvent, input: { proxyDraft: any; proxyId?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const result = await ProxyManager.testProxyAsync(input.proxyDraft, { proxyId: input.proxyId })
      return ok(result, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_CREATE, async (_e: IpcMainInvokeEvent, input: { draft: any; username?: string; password?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.createProxy(input.draft, input.username, input.password), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.listProxies(), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_UPDATE, async (_e: IpcMainInvokeEvent, input: { proxyId: string; patch: any }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.updateProxy(input.proxyId, input.patch), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_DELETE, async (_e: IpcMainInvokeEvent, input: { proxyId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok({ success: ProxyManager.deleteProxy(input.proxyId) }, requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_IMPORT_BATCH, async (_e: IpcMainInvokeEvent, input: { items: Array<{ draft: any; username?: string; password?: string }> }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const created = (input.items || []).map(item => ProxyManager.createProxy(item.draft, item.username, item.password))
      return ok({ created, count: created.length }, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_BIND, async (_e: IpcMainInvokeEvent, input: { storeId: string; proxyId: string | null }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      ProxyManager.bindProxy(input.storeId, input.proxyId)
      // 绑定即复检（§8.1 失败展示原因；只广播状态，绝不自动切换/降级）
      if (input.proxyId) {
        const proxyId = input.proxyId
        ProxyManager.revalidateProxy(proxyId).then(r => {
          if (r) emitToRenderer(EVENT_CHANNELS.PROXY_HEALTH_CHANGED, { proxyId, ...r, storeId: input.storeId })
        }).catch(() => { /* 复检异常不影响绑定结果 */ })
      }
      return ok({ success: true, binding: ProxyManager.getStoreProxy(input.storeId) }, requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_HISTORY, async (_e: IpcMainInvokeEvent, input: { proxyId: string; limit?: number }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.proxyHistory(input.proxyId, input.limit), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  // ---------- 会话状态 §6.3 ----------
  ipcMain.handle(IPC_CHANNELS.SESSION_STATUS, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const open = getOpenStoreIds().includes(input.storeId)
      return ok({
        storeId: input.storeId,
        open,
        tabCount: open ? getStoreTabs(input.storeId).length : 0,
        partition: `persist:store_${input.storeId}`,
        binding: ProxyManager.getStoreProxy(input.storeId),
        lastProxyAuth: getProxyAuthInjection(input.storeId)
      }, requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  // ---------- 备份 §6.5 ----------
  ipcMain.handle(IPC_CHANNELS.BACKUP_CREATE, async (_e: IpcMainInvokeEvent, input: { label?: string } | undefined): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await BackupManager.createBackup(input?.label), requestId)
    } catch (e: any) {
      return backupError(e, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.BACKUP_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(BackupManager.listBackups(), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.BACKUP_RESTORE, async (_e: IpcMainInvokeEvent, input: { backupId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await BackupManager.restoreBackup(input.backupId), requestId)
    } catch (e: any) {
      return backupError(e, requestId)
    }
  })
}
