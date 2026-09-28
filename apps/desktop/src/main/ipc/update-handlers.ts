import { familyHandle } from './family-handle'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import * as UpdateManager from '../services/update-manager'

const success = <T>(data: T): IPCResult<T> => ({ ok: true, data, requestId: randomUUID() })
const failure = (message: string): IPCResult => ({ ok: false, error: { code: 'UPDATE_ERROR', message }, requestId: randomUUID() })

const handle = familyHandle('应用更新')

export function registerUpdateHandlers(): void {
  handle(IPC_CHANNELS.UPDATE_STATUS, () => {
    try { return success(UpdateManager.getUpdateStatus()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
  handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try { return success(await UpdateManager.checkForUpdates()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
  handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try { return success(await UpdateManager.downloadUpdate()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
  handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    try { return success(UpdateManager.installUpdate()) } catch (error) { return failure(String((error as any)?.message || error)) }
  })
}
