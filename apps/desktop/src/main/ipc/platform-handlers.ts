/** 平台适配器登录状态 IPC：只暴露安全摘要，不暴露 Main 内部页面/Session 对象。 */

import type { IpcMainInvokeEvent } from 'electron'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { shopSessionStatusInputSchema } from '@shared/schemas/shop-session'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import { randomUUID } from 'crypto'

function rid(): string { return randomUUID() }
function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function err(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message }, requestId }
}

function detectionError(error: unknown, requestId: string): IPCResult {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('STORE_NOT_FOUND')) return err(ERROR_CODES.STORE_NOT_FOUND.code, ERROR_CODES.STORE_NOT_FOUND.message, requestId)
  if (message.includes('INVALID_ARGUMENT')) return err(ERROR_CODES.INVALID_ARGUMENT.code, ERROR_CODES.INVALID_ARGUMENT.message, requestId)
  return err(ERROR_CODES.INTERNAL_ERROR.code, '平台登录状态检测失败', requestId)
}

const handle = familyHandle('平台登录状态')

export function registerPlatformHandlers(): void {
  handle(IPC_CHANNELS.SESSION_CHECK_LOGIN_STATUS, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult> => {
    const requestId = rid()
    const parsed = shopSessionStatusInputSchema.safeParse(input)
    if (!parsed.success) return err(ERROR_CODES.INVALID_ARGUMENT.code, 'storeId 无效', requestId)
    try {
      const result = await detectStoreLoginStatus(parsed.data.storeId)
      // 这里返回的仍是第一阶段安全摘要；platformLogin 只含安全结果字段。
      const session = ShopSessionManager.getSessionStatus(parsed.data.storeId)
      return ok({ ...session, platformLogin: result }, requestId)
    } catch (error) {
      return detectionError(error, requestId)
    }
  })
}
