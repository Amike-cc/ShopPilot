/**
 * 素材库 IPC（2026-11-15）。
 *
 * 安全约定：
 * - 渲染层只提交 data URL / id，不提交或接收本地绝对路径；
 * - 原图由主进程写入 `userData/asset-library`，删除/定位都按 id 查表；
 * - 失败返回明确错误码与中文原因，不静默成功。
 */
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import type { AssetLibrarySource } from '@shared/contracts/asset-library'
import {
  AssetLibraryError,
  addAssetFromDataUrl,
  assetFilePathForReveal,
  listAssets,
  readAsset,
  removeAsset,
  updateAsset
} from '../services/asset-library'
import { writeAudit, auditRequestId } from '../services/audit-logger'
import { assertTrustedRenderer } from '../services/renderer-trust'
import { logMain } from '../services/logger'
import { ipcOk, ipcFail } from './envelope'

const success = <T>(data: T): IPCResult<T> => ipcOk(data, randomUUID())

function failure(error: unknown): IPCResult {
  const code = String((error as any)?.code || '')
  if (code === 'IPC_FORBIDDEN' || code === 'APP_LOCKED') {
    return ipcFail(code, String((error as any)?.message || '调用被拒绝'), randomUUID())
  }
  if (error instanceof AssetLibraryError) {
    return ipcFail(error.code, error.message.replace(/^[A-Z_]+:\s*/, ''), randomUUID())
  }
  const message = String((error as Error)?.message || error).replace(/^[A-Z_]+:\s*/, '')
  logMain('warn', `[asset-library] 操作失败：${message}`)
  return ipcFail('ASSET_FAILED', message || '素材库操作失败', randomUUID())
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  assertTrustedRenderer(event, { forbiddenCode: 'IPC_FORBIDDEN', feature: '素材库' })
}

export function registerAssetLibraryHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ASSETS_LIST, (event: IpcMainInvokeEvent, input?: {
    query?: string
    source?: 'upload' | 'chat-image' | 'all'
    tag?: string
    offset?: number
    limit?: number
  }): IPCResult => {
    try {
      assertTrusted(event)
      // 筛选/分页都在服务层过 normalizeAssetListInput：非法值夹到合法范围，不拼进 SQL 裸用
      return success(listAssets(input || {}))
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSETS_ADD_DATA_URL, (event: IpcMainInvokeEvent, input: {
    dataUrl?: string
    name?: string
    tags?: string[] | string
    source?: AssetLibrarySource
  }): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const result = addAssetFromDataUrl(input || {})
      writeAudit('assets.add', 'success', { requestId: auditRequestId(requestId, `${result.item.id}${result.duplicate ? '(重复)' : ''}`) })
      return success(result)
    } catch (error) {
      writeAudit('assets.add', 'failure', { requestId: auditRequestId(requestId, String((error as any)?.code || 'ASSET_FAILED')) })
      return failure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSETS_UPDATE, (event: IpcMainInvokeEvent, input: {
    id?: string
    name?: string
    tags?: string[] | string
  }): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const item = updateAsset(input || {})
      writeAudit('assets.update', 'success', { requestId: auditRequestId(requestId, item.id) })
      return success(item)
    } catch (error) {
      writeAudit('assets.update', 'failure', { requestId: auditRequestId(requestId, String((error as any)?.code || 'ASSET_FAILED')) })
      return failure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSETS_REMOVE, (event: IpcMainInvokeEvent, id: string): IPCResult => {
    const requestId = randomUUID()
    try {
      assertTrusted(event)
      const result = removeAsset(id)
      writeAudit('assets.remove', 'success', { requestId: auditRequestId(requestId, result.id) })
      return success(result)
    } catch (error) {
      writeAudit('assets.remove', 'failure', { requestId: auditRequestId(requestId, String((error as any)?.code || 'ASSET_FAILED')) })
      return failure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSETS_READ, (event: IpcMainInvokeEvent, id: string): IPCResult => {
    try {
      assertTrusted(event)
      return success(readAsset(id))
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSETS_REVEAL, (event: IpcMainInvokeEvent, id: string): IPCResult => {
    try {
      assertTrusted(event)
      shell.showItemInFolder(assetFilePathForReveal(id))
      return success({ revealed: true })
    } catch (error) {
      return failure(error)
    }
  })
}
