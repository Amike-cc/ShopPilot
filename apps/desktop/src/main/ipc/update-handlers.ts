import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import * as UpdateManager from '../services/update-manager'

const success = <T>(data: T): IPCResult<T> => ({ ok: true, data, requestId: randomUUID() })
const failure = (message: string): IPCResult => ({ ok: false, error: { code: 'UPDATE_ERROR', message }, requestId: randomUUID() })

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_STATUS, () => success(UpdateManager.getUpdateStatus()))
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try { return success(await UpdateManager.checkForUpdates()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try { return success(await UpdateManager.downloadUpdate()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => success(UpdateManager.installUpdate()))
}
