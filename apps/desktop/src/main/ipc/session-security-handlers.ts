/**
 * 会话包 / Cookie 查看器 / 应用锁 IPC 处理器 - §6.3 / §6.5 / §10.2
 */

import { ipcMain, IpcMainInvokeEvent, session } from 'electron'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { randomUUID } from 'crypto'
import * as SessionExporter from '../services/session-exporter'
import * as Security from '../services/security-manager'
import * as Diagnostics from '../services/diagnostics'
import { emitToRenderer, setBrowserViewsVisible } from '../browser/window-manager'
import { writeAudit } from '../services/audit-logger'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult { return { ok: false, error: { code, message }, requestId } }

function sessionError(e: any, requestId: string): IPCResult {
  const msg = String(e?.message || e)
  if (msg.startsWith('SESSION_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, msg.slice('SESSION_CANCELLED'.length + 2), requestId)
  if (msg.startsWith('SESSION_PACKAGE_EXPIRED')) return err(ERROR_CODES.SESSION_PACKAGE_EXPIRED.code, '会话包已过期，拒绝导入', requestId)
  if (msg.startsWith('SESSION_IMPORT_INVALID')) return err(ERROR_CODES.SESSION_IMPORT_INVALID.code, msg.replace('SESSION_IMPORT_INVALID: ', '会话包校验失败：'), requestId)
  if (msg.startsWith('APP_LOCKED')) return err(ERROR_CODES.APP_LOCKED.code, msg.replace('APP_LOCKED: ', ''), requestId)
  if (msg.includes('STORE_NOT_FOUND')) return err(ERROR_CODES.INTERNAL_ERROR.code, '店铺不存在', requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

function storeSession(storeId: string): Electron.Session {
  return session.fromPartition(`persist:store_${storeId}`, { cache: true })
}

export function registerSessionAndSecurityHandlers(): void {
  // ---------- 会话导出/导入 §6.3 ----------
  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_e: IpcMainInvokeEvent, input: { storeId: string; outputPath?: string; validDays?: number }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await SessionExporter.exportSessionPackage(input.storeId, { outputPath: input.outputPath, validDays: input.validDays }), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async (_e: IpcMainInvokeEvent, input: { storeId: string; filePath?: string; pickFile?: boolean }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await SessionExporter.importSessionPackage(input.storeId, input.filePath || '', { pickFile: input.pickFile }), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  // ---------- Cookie 查看器 ----------
  ipcMain.handle(IPC_CHANNELS.SESSION_COOKIES, async (_e: IpcMainInvokeEvent, input: { storeId: string; search?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const all = await storeSession(input.storeId).cookies.get({})
      let list = all.map((c: any) => ({
        name: c.name, domain: c.domain, path: c.path,
        valuePreview: String(c.value || '').slice(0, 24) + (String(c.value || '').length > 24 ? '…' : ''),
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        session: !c.expirationDate,
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toLocaleString('zh-CN') : '会话结束'
      }))
      if (input.search) {
        const q = input.search.toLowerCase()
        list = list.filter(x => x.name.toLowerCase().includes(q) || x.domain.toLowerCase().includes(q))
      }
      list.sort((a, b) => (a.domain + a.name).localeCompare(b.domain + b.name))
      return ok({ total: all.length, items: list.slice(0, 300) }, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE_COOKIE, async (_e: IpcMainInvokeEvent, input: { storeId: string; name: string; domain: string; path: string; secure?: boolean }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const url = `${input.secure ? 'https' : 'http'}://${input.domain.replace(/^\./, '')}${input.path || '/'}`
      await storeSession(input.storeId).cookies.remove(url, input.name)
      return ok({ removed: true }, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR_COOKIES, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      await storeSession(input.storeId).clearStorageData({ storages: ['cookies'] })
      writeAudit('browser.clearData', 'success', { storeId: input.storeId, requestId: JSON.stringify({ what: 'cookies' }) })
      return ok({ cleared: true }, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  // ---------- 诊断与审计导出 §6.7 ----------
  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS_EXPORT, async (_e: IpcMainInvokeEvent, input: { outputPath?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(Diagnostics.exportDiagnostics(input?.outputPath), requestId)
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.startsWith('DIAG_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, '已取消导出', requestId)
      return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.AUDIT_EXPORT, async (_e: IpcMainInvokeEvent, input: { filter?: any; outputPath?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(Diagnostics.exportAuditLogs(input?.filter || {}, input?.outputPath), requestId)
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.startsWith('DIAG_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, '已取消导出', requestId)
      return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
    }
  })

  // ---------- 应用锁 §6.5 ----------
  ipcMain.handle(IPC_CHANNELS.SECURITY_STATUS, async (): Promise<IPCResult> => {
    const requestId = rid()
    return ok(Security.getStatus(), requestId)
  })

  ipcMain.handle(IPC_CHANNELS.SECURITY_SET_PASSWORD, async (_e: IpcMainInvokeEvent, input: { password?: string; oldPassword?: string } | void): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await Security.setMasterPassword(input || {}), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.SECURITY_REMOVE_PASSWORD, async (_e: IpcMainInvokeEvent, input: { credential?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(Security.removeMasterPassword(input?.credential ?? ''), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  ipcMain.handle(IPC_CHANNELS.SECURITY_LOCK, async (): Promise<IPCResult> => {
    const requestId = rid()
    if (!Security.hasMasterPassword()) return err(ERROR_CODES.APP_LOCKED.code, '未设置主密码，无法锁定', requestId)
    Security.lockApp() // 敏感引用销毁 / 隐藏视图 / 广播事件由 index 注入的 hook 统一处理
    return ok({ locked: true }, requestId)
  })

  ipcMain.handle(IPC_CHANNELS.SECURITY_UNLOCK, async (_e: IpcMainInvokeEvent, input: { credential: string }): Promise<IPCResult> => {
    const requestId = rid()
    const success = Security.unlockApp(String(input?.credential ?? ''))
    if (!success) return err(ERROR_CODES.APP_LOCKED.code, '主密码不正确', requestId)
    setBrowserViewsVisible(true)
    emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: false })
    return ok({ locked: false }, requestId)
  })
}
