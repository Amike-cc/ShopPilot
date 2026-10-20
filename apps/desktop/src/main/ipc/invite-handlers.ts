/**
 * 达人邀约 IPC：
 *   · 旧台账查询（INVITE_RECENT_HISTORY）——面板开跑前取近 7 天昵称；
 *   · v2 批次/逐人记录（2026-10-19）——独立模块页读取，启动仍走 TaskRunner。
 *
 * 走 `familyHandle`（家族级可信渲染层校验）——与其它业务家族同一口径，
 * 不新增裸 `ipcMain.handle`（`tests/unit/ipc-trust-guard.test.ts` 会把裸注册判成失败）。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import type { InviteCampaignStartInput } from '@shared/invite-campaign'
import { ERROR_CODES } from '@shared/errors/error-codes'
import { randomUUID } from 'crypto'
import { familyHandle } from './family-handle'
import { INVITE_REPEAT_WINDOW_DAYS, listInvites, recentInvitedNicknames } from '../services/invite-history'
import {
  cancelScheduledInviteCampaign,
  getInviteCampaignDetail,
  listInviteCampaigns
} from '../services/invite-campaigns'
import { inviteRecordSummary, listInviteRecords, updateInviteRecordStatus } from '../services/invite-records'
import { getInviteQuota } from '../services/invite-quota'
import { listBlacklistedNicknames, listCreators, updateCreator } from '../services/invite-creators'
import { deleteInviteProductSet, deleteInviteScript, listInviteProductSets, listInviteScripts, saveInviteProductSet, saveInviteScript } from '../services/invite-assets'
import { recordInviteEvent } from '../services/invite-events'
import { startInviteCampaign } from '../services/invite-campaign-service'
import { getDatabase } from '../db/database'
import { logMain } from '../services/logger'
import { ipcFail as error, ipcOk as ok } from './envelope'

const handle = familyHandle('达人邀约')

function rid(): string {
  return randomUUID()
}

function inviteError(err: any, requestId: string): IPCResult {
  const message = String(err?.message || err)
  if (message.includes('TASK_INVALID_STEP') || err?.name === 'ZodError') {
    return error(ERROR_CODES.TASK_INVALID_STEP.code, `邀约步骤不合法：${message.replace('TASK_INVALID_STEP:', '').trim().slice(0, 300)}`, requestId)
  }
  logMain('error', `[invite] 操作失败：${message.slice(0, 500)}`)
  return error(ERROR_CODES.INTERNAL_ERROR.code, message.slice(0, 300) || '达人邀约操作失败', requestId)
}

export function registerInviteHandlers(): void {
  handle(IPC_CHANNELS.INVITE_RECENT_HISTORY, (_event: IpcMainInvokeEvent, input: { storeId?: string; days?: number; limit?: number } = {}): IPCResult => {
    const requestId = rid()
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

  /**
   * 创建批次 + 任务 + 运行。
   *
   * 编排逻辑在 `services/invite-campaign-service.ts`（可脱离 Electron 单测）；
   * 这里只做参数透传、错误映射与 envelope。
   */
  handle(IPC_CHANNELS.INVITE_CAMPAIGN_START, async (_event: IpcMainInvokeEvent, input: InviteCampaignStartInput): Promise<IPCResult> => {
    const requestId = rid()
    try {
      const result = startInviteCampaign(input)
      if (!result.ok) return error(result.code, result.message, requestId)
      return ok({
        campaignId: result.campaignId,
        task: result.task,
        run: result.run,
        waitingForStore: result.waitingForStore,
        // service 的权威排期时间（null=立即启动）：渲染层要展示"已排期于 X"得从这里拿
        scheduledAt: result.scheduledAt
      }, requestId)
    } catch (err) {
      return inviteError(err, requestId)
    }
  })

  handle(IPC_CHANNELS.INVITE_CAMPAIGN_LIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; limit?: number } = {}): IPCResult => {
    const requestId = rid()
    try {
      return ok(listInviteCampaigns({ storeId: input?.storeId ? String(input.storeId) : undefined, limit: input?.limit }), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_CAMPAIGN_DETAIL, (_event: IpcMainInvokeEvent, input: { campaignId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const campaignId = String(input?.campaignId || '')
      if (!campaignId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 campaignId', requestId)
      const detail = getInviteCampaignDetail(campaignId)
      if (!detail) return error(ERROR_CODES.TASK_NOT_FOUND.code, '邀约批次不存在', requestId)
      return ok(detail, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  /**
   * 取消排期：只对 scheduled 生效。已经跑起来的批次要走任务取消（INVITE 停止按钮），
   * 这里明确返回 false，避免用户以为"取消排期"能停掉正在跑的发送。
   */
  handle(IPC_CHANNELS.INVITE_CAMPAIGN_CANCEL, (_event: IpcMainInvokeEvent, input: { campaignId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const campaignId = String(input?.campaignId || '')
      if (!campaignId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 campaignId', requestId)
      // 取消前先取一次详情拿 storeId：取消后按店铺过滤事件流时这条不能丢（同文件其它事件都带）
      const before = getInviteCampaignDetail(campaignId)
      const cancelled = cancelScheduledInviteCampaign(campaignId)
      if (!cancelled) return error(ERROR_CODES.TASK_BAD_STATE.code, '该批次不在排期状态（可能已启动或已取消）', requestId)
      recordInviteEvent({ campaignId, storeId: before?.campaign?.storeId || undefined, type: 'campaign.schedule_cancelled', payload: {} })
      return ok({ campaignId, cancelled: true }, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_RECORDS_LIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; campaignId?: string; status?: string; limit?: number; offset?: number } = {}): IPCResult => {
    const requestId = rid()
    try {
      return ok(listInviteRecords({
        storeId: input?.storeId ? String(input.storeId) : undefined,
        campaignId: input?.campaignId ? String(input.campaignId) : undefined,
        status: input?.status ? String(input.status) : undefined,
        limit: input?.limit,
        offset: input?.offset
      }), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_RECORDS_SUMMARY, (_event: IpcMainInvokeEvent, input: { storeId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      return ok(inviteRecordSummary(input?.storeId ? String(input.storeId) : undefined), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_RECORDS_UPDATE_STATUS, (_event: IpcMainInvokeEvent, input: { id?: string; storeId?: string; status?: string; reason?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const id = String(input?.id || '')
      const storeId = String(input?.storeId || '')
      const status = String(input?.status || '')
      if (!id || !storeId || !status) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少记录/店铺/状态', requestId)
      const updated = updateInviteRecordStatus({ id, storeId, status: status as any, reason: input?.reason })
      if (!updated) return error(ERROR_CODES.INVALID_ARGUMENT.code, '状态值不合法或记录不存在', requestId)
      recordInviteEvent({ storeId, recordId: id, type: 'record.status.manual', payload: { status, reason: input?.reason || null } })
      return ok({ updated: true }, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_QUOTA_GET, (_event: IpcMainInvokeEvent, input: { storeId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const storeId = String(input?.storeId || '')
      if (!storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 storeId', requestId)
      const store = getDatabase().prepare('SELECT platform FROM stores WHERE id = ? AND deleted_at IS NULL').get(storeId) as { platform: string } | undefined
      if (!store) return error(ERROR_CODES.TASK_NOT_FOUND.code, '店铺不存在或已在回收站', requestId)
      return ok(getInviteQuota(storeId, store.platform), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_CREATORS_LIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; platform?: string; query?: string; blacklisted?: boolean; limit?: number } = {}): IPCResult => {
    const requestId = rid()
    try {
      return ok(listCreators({
        storeId: input?.storeId ? String(input.storeId) : undefined,
        platform: input?.platform ? String(input.platform) : undefined,
        query: input?.query ? String(input.query) : undefined,
        blacklisted: typeof input?.blacklisted === 'boolean' ? input.blacklisted : undefined,
        limit: input?.limit
      }), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_CREATORS_UPDATE, (_event: IpcMainInvokeEvent, input: { storeId?: string; platform?: string; creatorKey?: string; tags?: string[]; note?: string | null; blacklisted?: boolean; blacklistReason?: string | null } = {}): IPCResult => {
    const requestId = rid()
    try {
      const storeId = String(input?.storeId || '')
      const platform = String(input?.platform || '')
      const creatorKey = String(input?.creatorKey || '')
      if (!storeId || !platform || !creatorKey) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少店铺/平台/达人标识', requestId)
      const updated = updateCreator({ ...input, storeId, platform, creatorKey })
      if (!updated) return error(ERROR_CODES.TASK_NOT_FOUND.code, '达人不存在', requestId)
      recordInviteEvent({
        storeId, type: 'creator.updated',
        payload: { creatorKey, blacklisted: !!input.blacklisted, hasTags: Array.isArray(input.tags), hasNote: input.note !== undefined }
      })
      return ok(updated, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_CREATORS_BLACKLIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; platform?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const storeId = String(input?.storeId || '')
      const platform = String(input?.platform || '')
      if (!storeId || !platform) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少店铺/平台', requestId)
      return ok({ nicknames: listBlacklistedNicknames(storeId, platform) }, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_SCRIPTS_LIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; platform?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const storeId = String(input?.storeId || '')
      if (!storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 storeId', requestId)
      return ok(listInviteScripts({ storeId, platform: input?.platform ? String(input.platform) : undefined }), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_SCRIPTS_SAVE, (_event: IpcMainInvokeEvent, input: { id?: string; storeId?: string; platform?: string; name?: string; mode?: 'manual' | 'ai'; template?: string; maxLen?: number | null } = {}): IPCResult => {
    const requestId = rid()
    try {
      const saved = saveInviteScript({
        id: input?.id ? String(input.id) : undefined,
        storeId: String(input?.storeId || ''),
        platform: String(input?.platform || ''),
        name: String(input?.name || ''),
        mode: input?.mode === 'ai' ? 'ai' : 'manual',
        template: String(input?.template || ''),
        maxLen: input?.maxLen
      })
      if (!saved) return error(ERROR_CODES.INVALID_ARGUMENT.code, '话术名称与内容不能为空', requestId)
      recordInviteEvent({ storeId: saved.storeId, type: 'script.saved', payload: { scriptId: saved.id, name: saved.name } })
      return ok(saved, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_SCRIPTS_DELETE, (_event: IpcMainInvokeEvent, input: { id?: string; storeId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const id = String(input?.id || '')
      const storeId = String(input?.storeId || '')
      if (!id || !storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少话术/店铺', requestId)
      const deleted = deleteInviteScript(id, storeId)
      if (deleted) recordInviteEvent({ storeId, type: 'script.deleted', payload: { scriptId: id } })
      return ok({ deleted }, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_PRODUCT_SETS_LIST, (_event: IpcMainInvokeEvent, input: { storeId?: string; platform?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const storeId = String(input?.storeId || '')
      if (!storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少 storeId', requestId)
      return ok(listInviteProductSets({ storeId, platform: input?.platform ? String(input.platform) : undefined }), requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_PRODUCT_SETS_SAVE, (_event: IpcMainInvokeEvent, input: { id?: string; storeId?: string; platform?: string; name?: string; productIds?: string[] } = {}): IPCResult => {
    const requestId = rid()
    try {
      const saved = saveInviteProductSet({
        id: input?.id ? String(input.id) : undefined,
        storeId: String(input?.storeId || ''),
        platform: String(input?.platform || ''),
        name: String(input?.name || ''),
        productIds: Array.isArray(input?.productIds) ? input.productIds.map(String) : []
      })
      if (!saved) return error(ERROR_CODES.INVALID_ARGUMENT.code, '商品集名称与商品 ID 不能为空', requestId)
      recordInviteEvent({ storeId: saved.storeId, type: 'productSet.saved', payload: { setId: saved.id, name: saved.name, count: saved.productIds.length } })
      return ok(saved, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })

  handle(IPC_CHANNELS.INVITE_PRODUCT_SETS_DELETE, (_event: IpcMainInvokeEvent, input: { id?: string; storeId?: string } = {}): IPCResult => {
    const requestId = rid()
    try {
      const id = String(input?.id || '')
      const storeId = String(input?.storeId || '')
      if (!id || !storeId) return error(ERROR_CODES.INVALID_ARGUMENT.code, '缺少商品集/店铺', requestId)
      const deleted = deleteInviteProductSet(id, storeId)
      if (deleted) recordInviteEvent({ storeId, type: 'productSet.deleted', payload: { setId: id } })
      return ok({ deleted }, requestId)
    } catch (err) { return inviteError(err, requestId) }
  })
}
