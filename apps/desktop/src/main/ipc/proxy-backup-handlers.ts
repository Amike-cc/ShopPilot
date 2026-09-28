/**
 * 代理 / 备份 / 会话状态 IPC 处理器 - §6.3 / §6.5
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { shopSessionStatusInputSchema } from '@shared/schemas/shop-session'
import * as ProxyManager from '../browser/proxy-manager'
import * as BackupManager from '../services/backup-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { emitToRenderer } from '../browser/window-manager'
import { randomUUID } from 'crypto'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult { return { ok: false, error: { code, message }, requestId } }

function proxyError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('PROXY_INVALID')) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

function sessionStatusError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('STORE_NOT_FOUND')) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
  if (msg.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, ERROR_CODES.INVALID_ARGUMENT.message, requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

function backupError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('BACKUP_CHECKSUM_FAILED')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, ERROR_CODES.BACKUP_CHECKSUM_FAILED.message, requestId)
  if (msg.includes('BACKUP_NOT_FOUND')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份不存在或文件缺失', requestId)
  if (msg.includes('BACKUP_VERSION_TOO_NEW')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份来自更高版本，请先升级应用', requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

const handle = familyHandle('代理与备份')

export function registerProxyAndBackupHandlers(): void {
  // ---------- 代理 §6.3 ----------
  handle(IPC_CHANNELS.PROXY_TEST, async (_e: IpcMainInvokeEvent, input: { proxyDraft: any; proxyId?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const result = await ProxyManager.testProxyAsync(input.proxyDraft, { proxyId: input.proxyId })
      return ok(result, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_CREATE, async (_e: IpcMainInvokeEvent, input: { draft: any; username?: string; password?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.createProxy(input.draft, input.username, input.password), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.listProxies(), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_UPDATE, async (_e: IpcMainInvokeEvent, input: { proxyId: string; patch: any }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await ProxyManager.updateProxy(input.proxyId, input.patch), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_DELETE, async (_e: IpcMainInvokeEvent, input: { proxyId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      // unboundStores 回给界面：删掉被绑定的代理会让那几家店**回落直连真实 IP**，
      // 这是用户必须知道的事（此前只回 success，界面一句提示都没有）
      const { deleted, unboundStores } = await ProxyManager.deleteProxy(input.proxyId)
      return ok({ success: deleted, unboundStores }, requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_IMPORT_BATCH, async (_e: IpcMainInvokeEvent, input: { items: Array<{ draft: any; username?: string; password?: string }> }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const created = (input.items || []).map(item => ProxyManager.createProxy(item.draft, item.username, item.password))
      return ok({ created, count: created.length }, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_BIND, async (_e: IpcMainInvokeEvent, input: { storeId: string; proxyId: string | null }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      await ProxyManager.bindProxy(input.storeId, input.proxyId)
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

  handle(IPC_CHANNELS.PROXY_HISTORY, async (_e: IpcMainInvokeEvent, input: { proxyId: string; limit?: number }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.proxyHistory(input.proxyId, input.limit), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  // ---------- 会话状态 §6.3 ----------
  // 只返回 Session 安全摘要，不返回 partition、Cookie、Token 或代理认证信息。
  handle(IPC_CHANNELS.SESSION_STATUS, async (_e: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = shopSessionStatusInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, 'storeId 无效', requestId)
    try {
      // 保留现有环境面板需要的代理绑定摘要；仅返回 proxyId/mode，
      // 不把 partition、凭据、Cookie、Token 或 Electron Session 带到 Renderer。
      const status = ShopSessionManager.getSessionStatus(parsed.data.storeId)
      return ok({ ...status, binding: ProxyManager.getStoreProxy(parsed.data.storeId) }, requestId)
    } catch (e: any) {
      return sessionStatusError(e, requestId)
    }
  })

  // ---------- 备份 §6.5 ----------
  handle(IPC_CHANNELS.BACKUP_CREATE, async (_e: IpcMainInvokeEvent, input: { label?: string } | undefined): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await BackupManager.createBackup(input?.label), requestId)
    } catch (e: any) {
      return backupError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.BACKUP_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(BackupManager.listBackups(), requestId)
    } catch (e: any) {
      return err(ERROR_CODES.INTERNAL_ERROR.code, String(e?.message), requestId)
    }
  })

  handle(IPC_CHANNELS.BACKUP_RESTORE, async (_e: IpcMainInvokeEvent, input: { backupId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await BackupManager.restoreBackup(input.backupId), requestId)
    } catch (e: any) {
      return backupError(e, requestId)
    }
  })
}
