/**
 * IPC 处理器 - 店铺管理
 * §6.1 店铺 IPC 接口
 */

import { familyHandle } from './family-handle'
import { IpcMainInvokeEvent, BrowserWindow, dialog, app } from 'electron'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
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
import * as TaskStore from '../tasks/task-store'
import * as Runner from '../tasks/task-runner'
import { buildStoreCsv, parseStoreCsv } from '@shared/store-csv'
import { ensureCsvExtension } from '@shared/invoice-csv'
import { platformAdminUrl } from '@shared/constants/platforms'
import { writeAudit } from '../services/audit-logger'
import { randomUUID } from 'crypto'
import { ipcOk as success, ipcFail as error, ipcErrFromUnknown } from './envelope'

/**
 * 生成请求 ID
 */
function generateRequestId(): string {
  return randomUUID()
}

function storeIdentityKey(name: string, platform: string, adminUrl: string): string {
  return `${name.trim().toLowerCase()}\u0000${platform.trim().toLowerCase()}\u0000${adminUrl.trim().toLowerCase()}`
}

function invalidInput(requestId: string, issues: Array<{ path: PropertyKey[]; message: string }>): IPCResult {  return error(
    ERROR_CODES.INVALID_ARGUMENT.code,
    ERROR_CODES.INVALID_ARGUMENT.message,
    requestId,
    issues.slice(0, 8).map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message }))
  )
}

/**
 * 删除/彻底删除时浏览器运行时没收敛：按店铺浏览器运行中的错误码返回，
 * 让界面提示"先关闭该店铺浏览器"而不是 INTERNAL_ERROR 这种没法行动的错误
 */
function runtimeCloseError(err: any, requestId: string): IPCResult {
  const msg = String(err?.message || err)
  if (msg.includes('PROFILE_IN_USE')) {
    return error(ERROR_CODES.PROFILE_IN_USE.code, msg.replace(/^PROFILE_IN_USE:\s*/, ''), requestId)
  }
  // 兜底走共享脱敏（P1-2）：浏览器运行时异常可能带内部路径/进程错误串
  return ipcErrFromUnknown(err, requestId, { fallback: '店铺操作失败' })
}

/**
 * 注册所有店铺相关的 IPC 处理器
 */
const handle = familyHandle('店铺管理')

export function registerStoreHandlers(): void {
  // store:list
  handle(IPC_CHANNELS.STORE_LIST, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const stores = StoreManager.listStores()
      return success(stores, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:exportCsv - 导出店铺清单（元数据，不含会话/凭据）
  handle(IPC_CHANNELS.STORE_EXPORT_CSV, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const stores = StoreManager.listStores()
      if (!stores.length) return error(ERROR_CODES.INVALID_ARGUMENT.code, '当前没有可导出的店铺', requestId)
      const { csv, rows } = buildStoreCsv(stores)
      const stamp = new Date().toISOString().slice(0, 10)
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, {
        title: '导出店铺清单',
        defaultPath: join(app.getPath('documents'), `店铺清单-${stamp}.csv`),
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
      })
      if (res.canceled || !res.filePath) return success({ canceled: true }, requestId)
      const filePath = ensureCsvExtension(res.filePath)
      writeFileSync(filePath, '\uFEFF' + csv, 'utf8')
      writeAudit('store.export', 'success', { requestId: JSON.stringify({ rows }) })
      return success({ path: filePath, rows }, requestId)
    } catch (err: unknown) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, String((err as Error)?.message || err), requestId)
    }
  })

  // store:importPreview - 选择 CSV 并解析预览（不落库）
  handle(IPC_CHANNELS.STORE_IMPORT_PREVIEW, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const testFile = process.env.SHOPILOT_ACCEPTANCE === '1' ? String(process.env.SHOPILOT_TEST_STORE_IMPORT_CSV || '') : ''
      let filePath = testFile
      if (!filePath) {
        const picked = await dialog.showOpenDialog(win, {
          title: '选择店铺清单 CSV',
          properties: ['openFile'],
          filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
        })
        if (picked.canceled || !picked.filePaths?.length) return success({ canceled: true }, requestId)
        filePath = picked.filePaths[0]
      }
      const text = readFileSync(filePath, 'utf8')
      const parsed = parseStoreCsv(text, 500)
      if (parsed.headerError) return error(ERROR_CODES.INVALID_ARGUMENT.code, parsed.headerError, requestId)
      const existing = new Set(StoreManager.listStores().map(store => storeIdentityKey(store.name, store.platform, store.adminUrl)))
      const counts = { new: 0, duplicate: 0, invalid: 0 }
      const rows = parsed.rows.map(row => {
        const reasons = [...row.errors]
        let status: 'new' | 'duplicate' | 'invalid' = 'new'
        if (reasons.length) status = 'invalid'
        else if (existing.has(storeIdentityKey(row.name, row.platform, row.adminUrl))) { status = 'duplicate'; reasons.push('同名/同平台/同地址的店铺已存在') }
        if (status === 'new') counts.new++
        else if (status === 'duplicate') counts.duplicate++
        else counts.invalid++
        return { ...row, status, reasons }
      })
      return success({ rows, counts }, requestId)
    } catch (err: unknown) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, String((err as Error)?.message || err), requestId)
    }
  })

  // store:importApply - 把预览中选中的行真正创建为店铺（逐行校验，失败如实回报）
  handle(IPC_CHANNELS.STORE_IMPORT_APPLY, async (_event: IpcMainInvokeEvent, input: { rows?: unknown }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    const rows = Array.isArray(input?.rows) ? input.rows.slice(0, 500) as Array<Record<string, unknown>> : []
    if (!rows.length) return error(ERROR_CODES.INVALID_ARGUMENT.code, '没有可导入的店铺', requestId)
    let created = 0
    const failed: Array<{ line: number; name: string; message: string }> = []
    const existing = new Set(StoreManager.listStores().map(store => storeIdentityKey(store.name, store.platform, store.adminUrl)))
    for (const raw of rows) {
      const line = Number(raw.line) || 0
      const name = String(raw.name || '').trim()
      const platform = String(raw.platform || '').trim()
      try {
        const candidate = {
          name,
          platform,
          adminUrl: String(raw.adminUrl || '').trim() || platformAdminUrl(platform),
          tags: Array.isArray(raw.tags) ? raw.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 50) : [],
          notes: String(raw.notes || '').trim(),
          owner: String(raw.owner || '').trim(),
          region: String(raw.region || '').trim(),
          externalCode: String(raw.externalCode || '').trim(),
          licenseName: String(raw.licenseName || '').trim(),
          licenseNo: String(raw.licenseNo || '').trim()
        }
        const parsed = storeCreateSchema.safeParse(candidate)
        if (!parsed.success) {
          failed.push({ line, name, message: parsed.error.issues[0]?.message || '字段不合法' })
          continue
        }
        const key = storeIdentityKey(parsed.data.name, parsed.data.platform, parsed.data.adminUrl || '')
        if (existing.has(key)) {
          failed.push({ line, name, message: '同名/同平台/同地址的店铺已存在' })
          continue
        }
        const store = StoreManager.createStore(parsed.data)
        const groupName = String(raw.groupName || '').trim().slice(0, 120)
        if (groupName) {
          try { StoreManager.setStoreGroup(store.id, groupName) } catch { /* 分组失败不影响店铺本身 */ }
        }
        existing.add(key)
        created++
      } catch (err: unknown) {
        failed.push({ line, name, message: String((err as Error)?.message || err) })
      }
    }
    writeAudit('store.import', created ? 'success' : 'failure', {
      requestId: JSON.stringify({ created, failed: failed.length })
    })
    return success({ created, failed }, requestId)
  })

  // store:get
  handle(IPC_CHANNELS.STORE_GET, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.STORE_CREATE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeCreateSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const store = StoreManager.createStore(parsed.data)
      
      // §8.1 步骤 3（创建 browser_profile）已在 StoreManager.createStore 的同一事务内完成
      // （ensureProfileForStore），不再由 IPC 层补写；建店入参本就不含代理，
      // §8.1 步骤 5 的代理连接测试发生在 proxy:bind（proxy-backup-handlers 的绑定体检）。
      
      return success(store, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:update
  handle(IPC_CHANNELS.STORE_UPDATE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.STORE_ARCHIVE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.STORE_RESTORE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
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
  handle(IPC_CHANNELS.STORE_DELETE_PERMANENT, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      // 店铺的浏览器视图/会话在 store-manager 内先收敛（releaseStoreRuntime）；
      // profile 与下载**记录**随 stores 级联删除，下载目录与 session partition 在彻底删除时清理（见 purgeStore）
      const success = StoreManager.deleteStorePermanent(parsed.data.storeId)
      
      if (!success) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
      }
      
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return runtimeCloseError(err, requestId)
    }
  })
  
  // store:trashList - 回收站列表（软删除店铺）
  handle(IPC_CHANNELS.STORE_TRASH_LIST, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(StoreManager.listTrashStores(), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // store:purge - 彻底删除（回收站内，二次确认后）
  handle(IPC_CHANNELS.STORE_PURGE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const parsed = storeIdInputSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const storeId = parsed.data.storeId
      /**
       * B1（2026-10-15 审查）：彻底删除不可撤销 → 必须同时收敛该店的任务。
       * 以前只删店铺行，任务成孤儿（tasks.store_scope 无外键、不会级联）：此后每次调度触发
       * 都在 createRun 撞 `FOREIGN KEY constraint failed`（task_runs.store_id 引用已删店铺），
       * 手动运行也把这条库报错原样丢给用户。
       * 顺序：先确认在回收站（不合格不动任何任务）→ 取消内存中的运行 → 删该店全部任务（级联 runs）→ 删店铺。
       * 软删（移入回收站）刻意不走这里：恢复店铺后任务要继续可用。
       */
      if (!StoreManager.isStoreInTrash(storeId)) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, '回收站中未找到该店铺', requestId)
      }
      for (const run of Runner.listLiveRuns().filter(r => r.storeId === storeId)) {
        try { Runner.cancelRun(run.runId, '店铺被彻底删除') } catch { /* 已结束/状态瞬态无妨 */ }
      }
      for (const task of TaskStore.listTasks().filter(t => t.storeScope === storeId)) {
        try { TaskStore.deleteTask(task.id) } catch { /* 单条清理失败不阻塞删除主流程 */ }
      }
      const ok = await StoreManager.purgeStore(storeId)
      if (!ok) {
        return error(ERROR_CODES.STORE_NOT_FOUND.code, '回收站中未找到该店铺', requestId)
      }
      return success({ success: true }, requestId)
    } catch (err: any) {
      return runtimeCloseError(err, requestId)
    }
  })

  // store:reorder
  handle(IPC_CHANNELS.STORE_REORDER, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = generateRequestId()
    
    try {
      const parsed = storeReorderSchema.safeParse(input)
      if (!parsed.success) return invalidInput(requestId, parsed.error.issues)
      const reordered = StoreManager.reorderStores(parsed.data.orderedStoreIds)
      if (!reordered) return error(ERROR_CODES.INVALID_ARGUMENT.code, '排序列表与当前店铺列表不一致，请刷新后重试', requestId)
      return { ok: true, data: { success: true }, requestId }
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
  
  // store:setGroup
  handle(IPC_CHANNELS.STORE_SET_GROUP, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
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
