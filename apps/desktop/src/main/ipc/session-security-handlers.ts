/**
 * 会话包 / Cookie 查看器 / 应用锁 IPC 处理器 - §6.3 / §6.5 / §10.2
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { randomUUID } from 'crypto'
import * as SessionExporter from '../services/session-exporter'
import * as SessionPersistence from '../services/session-persistence'
import * as Security from '../services/security-manager'
import * as Diagnostics from '../services/diagnostics'
import * as StoreManager from '../stores/store-manager'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { emitToRenderer, setBrowserViewsVisible } from '../browser/window-manager'
import { writeAudit, auditRequestId } from '../services/audit-logger'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult { return { ok: false, error: { code, message }, requestId } }

function sessionError(e: any, requestId: string): IPCResult {
  const msg = String(e?.message || e)
  if (msg.startsWith('SESSION_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, msg.slice('SESSION_CANCELLED'.length + 2), requestId)
  if (msg.startsWith('SESSION_PACKAGE_EXPIRED')) return err(ERROR_CODES.SESSION_PACKAGE_EXPIRED.code, '会话包已过期，拒绝导入', requestId)
  if (msg.startsWith('SESSION_IMPORT_INVALID')) return err(ERROR_CODES.SESSION_IMPORT_INVALID.code, msg.replace('SESSION_IMPORT_INVALID: ', '会话包校验失败：'), requestId)
  if (msg.startsWith('APP_LOCKED')) return err(ERROR_CODES.APP_LOCKED.code, msg.replace('APP_LOCKED: ', ''), requestId)
  if (msg.includes('STORE_NOT_FOUND')) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
  if (msg.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, msg.replace(/^.*INVALID_ARGUMENT:\s*/, ''), requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
}

/**
 * 带 storeId 的会话通道先确认店铺存在：partition 名是 `persist:store_<storeId>`，
 * 渲染层若塞任意字符串就能读写到别的分区（或凭空造出一个永不回收的 partition）。
 * 返回校验后的 storeId（拼 partition 只用它），店铺不存在返回 null。
 */
function requireStoreId(raw: unknown): string | null {
  const storeId = typeof raw === 'string' ? raw : ''
  if (!storeId) return null
  return StoreManager.getStore(storeId) ? storeId : null
}

function storeSession(storeId: string): Electron.Session {
  return ShopSessionManager.getSession(storeId)
}

// Session 数据操作遵守应用锁；只有安全状态/解锁等必要通道按通道放行。
const handle = familyHandle('会话与安全')

export function registerSessionAndSecurityHandlers(): void {
  // ---------- 会话导出/导入 §6.3 ----------
  handle(IPC_CHANNELS.SESSION_EXPORT, async (_e: IpcMainInvokeEvent, input: { storeId: string; outputPath?: string; validDays?: number }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const storeId = requireStoreId(input?.storeId)
      if (!storeId) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      return ok(await SessionExporter.exportSessionPackage(storeId, { outputPath: input.outputPath, validDays: input.validDays }), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  handle(IPC_CHANNELS.SESSION_IMPORT, async (_e: IpcMainInvokeEvent, input: { storeId: string; filePath?: string; pickFile?: boolean }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const storeId = requireStoreId(input?.storeId)
      if (!storeId) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      return ok(await SessionExporter.importSessionPackage(storeId, input.filePath || '', { pickFile: input.pickFile }), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  // ---------- Cookie 查看器 ----------
  handle(IPC_CHANNELS.SESSION_COOKIES, async (_e: IpcMainInvokeEvent, input: { storeId: string; search?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const storeId = requireStoreId(input?.storeId)
      if (!storeId) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      const all = await storeSession(storeId).cookies.get({})
      let list = all.map((c: any) => ({
        name: c.name, domain: c.domain, path: c.path,
        // Renderer 只显示存在性掩码，不把 Cookie 原文或前缀带出 Main。
        valuePreview: String(c.value || '').length > 0 ? '••••••' : '',
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

  handle(IPC_CHANNELS.SESSION_DELETE_COOKIE, async (_e: IpcMainInvokeEvent, input: { storeId: string; name: string; domain: string; path: string; secure?: boolean }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const storeId = requireStoreId(input?.storeId)
      if (!storeId) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      const url = `${input.secure ? 'https' : 'http'}://${input.domain.replace(/^\./, '')}${input.path || '/'}`
      await storeSession(storeId).cookies.remove(url, input.name)
      return ok({ removed: true }, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  handle(IPC_CHANNELS.SESSION_CLEAR_COOKIES, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const storeId = requireStoreId(input?.storeId)
      if (!storeId) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      await storeSession(storeId).clearStorageData({ storages: ['cookies'] })
      // 快照必须同步失效：否则下次启动 restoreStoreSession 会把刚清掉的会话级 Cookie 灌回来，
      // 用户会以为"清空 Cookie 没生效 / 软件偷偷保存了登录态"（2026-09-28 审查确认）。
      try { SessionPersistence.clearStoreSessionSnapshot(storeId) } catch { /* 快照清理失败不阻塞 */ }
      writeAudit('browser.clearData', 'success', { storeId, requestId: auditRequestId(requestId, 'cookies') })
      return ok({ cleared: true }, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  })

  // ---------- 诊断与审计导出 §6.7 ----------
  handle(IPC_CHANNELS.DIAGNOSTICS_EXPORT, async (_e: IpcMainInvokeEvent, input: { outputPath?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(Diagnostics.exportDiagnostics(input?.outputPath), requestId)
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.startsWith('DIAG_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, '已取消导出', requestId)
      if (msg.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, msg.replace(/^.*INVALID_ARGUMENT:\s*/, ''), requestId)
      return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
    }
  })

  handle(IPC_CHANNELS.AUDIT_EXPORT, async (_e: IpcMainInvokeEvent, input: { filter?: any; outputPath?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(Diagnostics.exportAuditLogs(input?.filter || {}, input?.outputPath), requestId)
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.startsWith('DIAG_CANCELLED')) return err(ERROR_CODES.SESSION_CANCELLED.code, '已取消导出', requestId)
      if (msg.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, msg.replace(/^.*INVALID_ARGUMENT:\s*/, ''), requestId)
      return err(ERROR_CODES.INTERNAL_ERROR.code, msg, requestId)
    }
  })

  // ---------- 应用锁 §6.5 ----------
  handle(IPC_CHANNELS.SECURITY_STATUS, async (): Promise<IPCResult> => {
    const requestId = rid()
    return ok(Security.getStatus(), requestId)
  }, { allowWhenLocked: true })

  handle(IPC_CHANNELS.SECURITY_SET_PASSWORD, async (_e: IpcMainInvokeEvent, input: { password?: string; oldPassword?: string } | void): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await Security.setMasterPassword(input || {}), requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  }, { allowWhenLocked: true })

  handle(IPC_CHANNELS.SECURITY_REMOVE_PASSWORD, async (_e: IpcMainInvokeEvent, input: { credential?: string }): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const wasLocked = Security.isAppLocked()
      const result = Security.removeMasterPassword(input?.credential ?? '')
      if (wasLocked) {
        // 移除主密码会同时解除应用锁（见 security-manager）：与 SECURITY_UNLOCK 对齐，
        // 必须恢复视图可见并广播状态，否则渲染层仍停在锁屏上
        setBrowserViewsVisible(true)
        emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: false })
      }
      return ok(result, requestId)
    } catch (e: any) { return sessionError(e, requestId) }
  }, { allowWhenLocked: true })

  handle(IPC_CHANNELS.SECURITY_LOCK, async (): Promise<IPCResult> => {
    const requestId = rid()
    if (!Security.hasMasterPassword()) return err(ERROR_CODES.APP_LOCKED.code, '未设置主密码，无法锁定', requestId)
    Security.lockApp() // 敏感引用销毁 / 隐藏视图 / 广播事件由 index 注入的 hook 统一处理
    return ok({ locked: true }, requestId)
  }, { allowWhenLocked: true })

  handle(IPC_CHANNELS.SECURITY_UNLOCK, async (_e: IpcMainInvokeEvent, input: { credential: string }): Promise<IPCResult> => {
    const requestId = rid()
    const success = Security.unlockApp(String(input?.credential ?? ''))
    if (!success) return err(ERROR_CODES.APP_LOCKED.code, '主密码不正确', requestId)
    setBrowserViewsVisible(true)
    emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: false })
    return ok({ locked: false }, requestId)
  }, { allowWhenLocked: true })
}
