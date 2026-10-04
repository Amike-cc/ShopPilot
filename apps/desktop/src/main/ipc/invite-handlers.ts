/**
 * 邀约台账 IPC：给面板/智能体查"近 N 天已邀过的达人"。
 *
 * 为什么要有这条：用户要求**7 天内邀过的达人不再重复邀约**。
 * 广场列表行没有"已邀约"标记、也拿不到 finderUsername（2026-10-04 真机实测），
 * 所以只能由本地台账提供昵称清单，任务在点「详情」前把这些行剔掉。
 *
 * 走 `familyHandle`（家族级可信渲染层校验）——与其它业务家族同一口径，
 * 不新增裸 `ipcMain.handle`（`tests/unit/ipc-trust-guard.test.ts` 会把裸注册判成失败）。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { randomUUID } from 'crypto'
import { familyHandle } from './family-handle'
import { INVITE_REPEAT_WINDOW_DAYS, listInvites, recentInvitedNicknames } from '../services/invite-history'
import { logMain } from '../services/logger'

const handle = familyHandle('达人邀约')

function error(code: string, message: string, requestId: string, details?: unknown): IPCResult {
  return { ok: false, error: { code, message, details }, requestId }
}

export function registerInviteHandlers(): void {
  handle(IPC_CHANNELS.INVITE_RECENT_HISTORY, (_event: IpcMainInvokeEvent, input: { storeId?: string; days?: number; limit?: number } = {}): IPCResult => {
    const requestId = randomUUID()
    try {
      const storeId = String(input?.storeId || '')
      if (!storeId) return error(ERROR_CODES.INTERNAL_ERROR.code, '缺少 storeId', requestId)
      const days = Number.isFinite(Number(input?.days)) ? Math.max(1, Math.min(90, Math.round(Number(input.days)))) : INVITE_REPEAT_WINDOW_DAYS
      return {
        ok: true,
        data: { days, nicknames: recentInvitedNicknames(storeId, days), entries: listInvites(storeId, Number(input?.limit) || 50) },
        requestId
      }
    } catch (err: any) {
      logMain('error', `[invite] 读取邀约台账失败: ${String(err?.message || err)}`)
      return error(ERROR_CODES.INTERNAL_ERROR.code, String(err?.message || err), requestId)
    }
  })
}
