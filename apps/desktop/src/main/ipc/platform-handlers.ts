/** 平台适配器登录状态 IPC：只暴露安全摘要，不暴露 Main 内部页面/Session 对象。 */

import type { IpcMainInvokeEvent } from 'electron'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, EVENT_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { shopSessionStatusInputSchema } from '@shared/schemas/shop-session'
import * as ShopSessionManager from '../browser/shop-session-manager'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import { emitToRenderer } from '../browser/window-manager'
import { randomUUID } from 'crypto'
import { ipcOk as ok, ipcFail as err } from './envelope'

function rid(): string { return randomUUID() }

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
      // 主动检测出的登录态不可用要广播出去（SESSION_EXPIRED 契约，此前主/渲染两侧都零引用）：
      // 渲染层据此刷新会话块并提示一次。
      //
      // 只有 LOGIN_REQUIRED（明确的"未登录 / 登录页 / 过期页"证据）才发：
      //   · UNKNOWN 是"这次没拿到证据"（页面没开、当前标签页不是档案页、超时），
      //   · ERROR 是检测本身失败，
      //   · VERIFY_REQUIRED 是"需要安全验证"（会话仍在，只是要人工过验证）——
      // 这三种都不是"过期"，报成 SESSION_EXPIRED 会把用户骗去重新登录。
      if (result.status === 'LOGIN_REQUIRED') {
        emitToRenderer(EVENT_CHANNELS.SESSION_EXPIRED, {
          storeId: result.storeId,
          reasonCode: result.reasonCode,
          safeMessage: result.safeMessage
        })
      }
      // 这里返回的仍是第一阶段安全摘要；platformLogin 只含安全结果字段。
      const session = ShopSessionManager.getSessionStatus(parsed.data.storeId)
      return ok({ ...session, platformLogin: result }, requestId)
    } catch (error) {
      return detectionError(error, requestId)
    }
  })
}
