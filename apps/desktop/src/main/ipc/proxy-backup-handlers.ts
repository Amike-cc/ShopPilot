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
import { z } from 'zod'
import { ipcOk as ok, ipcFail as err, ipcErrFromUnknown } from './envelope'

const proxyDraftSchema = z.object({
  type: z.enum(['http', 'https', 'socks5']),
  host: z.string().trim().min(1).max(255).refine(value => Buffer.byteLength(value, 'utf8') <= 255, '代理主机名过长'),
  port: z.number().int().min(1).max(65535),
  label: z.string().max(200).optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  expiresAt: z.number().int().positive().nullable().optional()
}).strict()
const proxyTestInputSchema = z.object({ proxyDraft: proxyDraftSchema, proxyId: z.string().trim().min(1).max(200).optional() }).strict()
const proxyCredentialSchema = z.string().max(512).refine(value => Buffer.byteLength(value, 'utf8') <= 255, '代理凭据超过 SOCKS5 单字节长度限制').optional()
const proxyCreateInputSchema = z.object({ draft: proxyDraftSchema, username: proxyCredentialSchema, password: proxyCredentialSchema }).strict()
const proxyUpdateInputSchema = z.object({
  proxyId: z.string().trim().min(1).max(200),
  patch: proxyDraftSchema.partial().extend({ username: proxyCredentialSchema, password: proxyCredentialSchema }).strict()
}).strict()
const proxyDeleteInputSchema = z.object({ proxyId: z.string().trim().min(1).max(200) }).strict()
const proxyBatchInputSchema = z.object({ items: z.array(proxyCreateInputSchema).max(200) }).strict()
const proxyBindInputSchema = z.object({ storeId: z.string().trim().min(1).max(200), proxyId: z.string().trim().min(1).max(200).nullable() }).strict()
const proxyHistoryInputSchema = z.object({ proxyId: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }).strict()

function rid(): string { return randomUUID() }

function proxyError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('PROXY_INVALID')) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
  if (msg.includes('PROXY_BATCH_TOO_LARGE') || msg.includes('PROXY_SOCKS5_CREDENTIAL_TOO_LONG')) return err(ERROR_CODES.INVALID_ARGUMENT.code, '代理批量或凭据参数超出限制', requestId)
  // 兜底走共享脱敏（P1-2）：代理探测异常常带底层网络错误串
  return ipcErrFromUnknown(errObj, requestId, { fallback: '代理操作失败' })
}

function sessionStatusError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('STORE_NOT_FOUND')) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
  if (msg.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, ERROR_CODES.INVALID_ARGUMENT.message, requestId)
  return ipcErrFromUnknown(errObj, requestId, { fallback: '会话状态查询失败' })
}

function backupError(errObj: any, requestId: string): IPCResult {
  const msg = String(errObj?.message || errObj)
  if (msg.includes('BACKUP_RESTORE_BUSY')) return err(ERROR_CODES.INVALID_ARGUMENT.code, '已有恢复操作正在进行，请稍候再试', requestId)
  if (msg.includes('BACKUP_PATH_UNSAFE')) return err(ERROR_CODES.INVALID_ARGUMENT.code, '备份路径不安全，已拒绝操作', requestId)
  if (msg.includes('BACKUP_CHECKSUM_FAILED')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, ERROR_CODES.BACKUP_CHECKSUM_FAILED.message, requestId)
  if (msg.includes('BACKUP_NOT_FOUND')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份不存在或文件缺失', requestId)
  if (msg.includes('BACKUP_VERSION_TOO_NEW')) return err(ERROR_CODES.BACKUP_CHECKSUM_FAILED.code, '备份来自更高版本，请先升级应用', requestId)
  // 备份读写异常常带绝对路径（文件不存在/校验失败），文案统一脱敏
  return ipcErrFromUnknown(errObj, requestId, { fallback: '备份操作失败' })
}

const handle = familyHandle('代理与备份')

export function registerProxyAndBackupHandlers(): void {
  // ---------- 代理 §6.3 ----------
  handle(IPC_CHANNELS.PROXY_TEST, async (_e: IpcMainInvokeEvent, input: { proxyDraft: any; proxyId?: string }): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyTestInputSchema.safeParse(input)
    // 代理草稿的结构/端口/协议属于代理域校验。统一返回 PROXY_INVALID，
    // 让 UI 与运行时 assertValidDraft 使用同一错误契约（此前 Zod 先拦截时
    // 返回 INVALID_ARGUMENT，导致 99999 端口/ftp 类型在实际接口上与文档不一致）。
    if (!parsed.success) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
    try {
      const result = await ProxyManager.testProxyAsync(parsed.data.proxyDraft, { proxyId: parsed.data.proxyId })
      return ok(result, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_CREATE, async (_e: IpcMainInvokeEvent, input: { draft: any; username?: string; password?: string }): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyCreateInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
    try {
      return ok(ProxyManager.createProxy(parsed.data.draft, parsed.data.username, parsed.data.password), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_LIST, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(ProxyManager.listProxies(), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_UPDATE, async (_e: IpcMainInvokeEvent, input: { proxyId: string; patch: any }): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyUpdateInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.PROXY_INVALID.code, ERROR_CODES.PROXY_INVALID.message, requestId)
    try {
      return ok(await ProxyManager.updateProxy(parsed.data.proxyId, parsed.data.patch), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_DELETE, async (_e: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyDeleteInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, '代理参数不合法', requestId)
    try {
      // unboundStores 回给界面：删掉被绑定的代理会让那几家店**回落直连真实 IP**，
      // 这是用户必须知道的事（此前只回 success，界面一句提示都没有）
      const { deleted, unboundStores } = await ProxyManager.deleteProxy(parsed.data.proxyId)
      return ok({ success: deleted, unboundStores }, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_IMPORT_BATCH, async (_e: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyBatchInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, '代理批量参数不合法', requestId)
    try {
      const created = ProxyManager.createProxiesBatch(parsed.data.items)
      return ok({ created, count: created.length }, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_BIND, async (_e: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyBindInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, '代理绑定参数不合法', requestId)
    try {
      await ProxyManager.bindProxy(parsed.data.storeId, parsed.data.proxyId)
      // 绑定即复检（§8.1 失败展示原因；只广播状态，绝不自动切换/降级）
      if (parsed.data.proxyId) {
        const proxyId = parsed.data.proxyId
        ProxyManager.revalidateProxy(proxyId).then(r => {
          if (r) emitToRenderer(EVENT_CHANNELS.PROXY_HEALTH_CHANGED, { proxyId, ...r, storeId: parsed.data.storeId })
        }).catch(() => { /* 复检异常不影响绑定结果 */ })
      }
      return ok({ success: true, binding: ProxyManager.getStoreProxy(parsed.data.storeId) }, requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
    }
  })

  handle(IPC_CHANNELS.PROXY_HISTORY, async (_e: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = proxyHistoryInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, '代理历史参数不合法', requestId)
    try {
      return ok(ProxyManager.proxyHistory(parsed.data.proxyId, parsed.data.limit), requestId)
    } catch (e: any) {
      return proxyError(e, requestId)
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
