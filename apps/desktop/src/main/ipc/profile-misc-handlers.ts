/**
 * 环境配置 / 概览 / 设置 / 审计 IPC 处理器 - §6.6 / §6.7
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { ERROR_CODES } from '@shared/errors/error-codes'
import * as ProfileManager from '../stores/profile-manager'
import { verifyStoreFingerprint } from '../browser/fingerprint-injector'
import { getDatabase } from '../db/database'
import { writeAudit, queryAudit } from '../services/audit-logger'
import { randomUUID } from 'crypto'

function generateRequestId(): string {
  return randomUUID()
}

function success<T>(data: T, requestId: string): IPCResult<T> {
  return { ok: true, data, requestId }
}

function error(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message }, requestId }
}

export function registerProfileAndMiscHandlers(): void {
  // profile:get
  ipcMain.handle(IPC_CHANNELS.PROFILE_GET, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.getProfile(input.storeId)
      if (!profile) return error(ERROR_CODES.PROFILE_NOT_READY.code, ERROR_CODES.PROFILE_NOT_READY.message, requestId)
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:update（locked 拒绝 + config_version 递增，§6.6）
  ipcMain.handle(IPC_CHANNELS.PROFILE_UPDATE, async (_e: IpcMainInvokeEvent, input: { storeId: string, patch: ProfileManager.ProfilePatch }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.updateProfile(input.storeId, input.patch)
      writeAudit('profile.update', 'success', { storeId: input.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      if (err instanceof ProfileManager.ProfileLockedError) {
        writeAudit('profile.update', 'failure', { storeId: input.storeId, requestId })
        return error(ERROR_CODES.PROFILE_LOCKED.code, ERROR_CODES.PROFILE_LOCKED.message, requestId)
      }
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:verify - 逐字段 实际/期望/已验证|未验证（§4.3：浏览器未开或注入失败如实标未验证）
  ipcMain.handle(IPC_CHANNELS.PROFILE_VERIFY, async (_e: IpcMainInvokeEvent, input: { storeId: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success({ items: await verifyStoreFingerprint(input.storeId) }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:lock
  ipcMain.handle(IPC_CHANNELS.PROFILE_LOCK, async (_e: IpcMainInvokeEvent, input: { storeId: string, locked: boolean }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const profile = ProfileManager.lockProfile(input.storeId, input.locked)
      writeAudit(input.locked ? 'profile.lock' : 'profile.unlock', 'success', { storeId: input.storeId, requestId })
      return success(profile, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // profile:copyConfig - 只复制配置，不含会话/凭据（§6.6）
  ipcMain.handle(IPC_CHANNELS.PROFILE_COPY_CONFIG, async (_e: IpcMainInvokeEvent, input: { sourceStoreId: string, targetStoreIds: string[] }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const result = ProfileManager.copyProfileConfig(input.sourceStoreId, input.targetStoreIds)
      writeAudit('profile.copyConfig', 'success', { storeId: input.sourceStoreId, requestId })
      return success(result, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // overview:stats - 工作台概览
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_STATS, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const db = getDatabase()
      const stats = {
        totalStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL').get() as any).c,
        onlineStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'online'").get() as any).c,
        archivedStores: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'archived'").get() as any).c,
        trashStores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NOT NULL').get() as any).c,
        downloads24h: (db.prepare('SELECT COUNT(*) c FROM downloads WHERE created_at > ?').get(Date.now() - 86400000) as any).c,
        bookmarks: (db.prepare('SELECT COUNT(*) c FROM bookmarks').get() as any).c
      }
      return success(stats, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  /**
   * overview:datacenter - 数据中心：汇总**所有店铺**的数据（只读）。
   * 数据来源都是本机既有表：stores / store_snapshots（任务 readText·readTable 的指标快照）/
   * task_runs（任务与邀约运行）。不做任何估算或补数：没有数据就如实返回空数组，由界面显示空状态。
   */
  ipcMain.handle(IPC_CHANNELS.OVERVIEW_DATACENTER, async (): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const db = getDatabase()
      const weekAgo = Date.now() - 7 * 86400000

      const byPlatform = db.prepare(
        'SELECT platform, COUNT(*) c, SUM(CASE WHEN status = \'online\' THEN 1 ELSE 0 END) online FROM stores WHERE deleted_at IS NULL GROUP BY platform ORDER BY c DESC'
      ).all() as any[]

      const totals = {
        stores: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL').get() as any).c,
        online: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'online'").get() as any).c,
        archived: (db.prepare("SELECT COUNT(*) c FROM stores WHERE deleted_at IS NULL AND status = 'archived'").get() as any).c,
        trash: (db.prepare('SELECT COUNT(*) c FROM stores WHERE deleted_at IS NOT NULL').get() as any).c,
        platforms: byPlatform.length,
        snapshots: (db.prepare('SELECT COUNT(*) c FROM store_snapshots').get() as any).c,
        tasks: (db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c
      }

      // 每店每指标的最新一条 + **上一条**（用于数据中心显示"较上次采集的增减"）
      const snapRows = db.prepare(`
        SELECT storeName, platform, metric, value_json, captured_at, rn FROM (
          SELECT s.name AS storeName, s.platform AS platform, sn.metric AS metric,
                 sn.value_json AS value_json, sn.captured_at AS captured_at,
                 ROW_NUMBER() OVER (PARTITION BY sn.store_id, sn.metric ORDER BY sn.rowid DESC) AS rn
          FROM store_snapshots sn
          JOIN stores s ON s.id = sn.store_id
        ) WHERE rn <= 2
        ORDER BY storeName, metric, rn
        LIMIT 600
      `).all() as any[]
      const parseVal = (json: any) => { try { return JSON.parse(json) } catch { return json } }
      const snapMap = new Map<string, any>()
      const snapshots: any[] = []
      for (const r of snapRows) {
        const key = r.storeName + '\u0000' + r.metric
        if (r.rn === 1) {
          const item = {
            storeName: r.storeName, platform: r.platform, metric: r.metric,
            value: parseVal(r.value_json), capturedAt: r.captured_at,
            prevValue: null as unknown
          }
          snapMap.set(key, item)
          snapshots.push(item)
        } else {
          const item = snapMap.get(key)
          if (item) item.prevValue = parseVal(r.value_json)
        }
      }

      // 邀约运行（任务名前缀「达人邀约 ·」）：状态分布 + 最近若干条
      const inviteWhere = "t.name LIKE '达人邀约 ·%'"
      const inviteByStatus = db.prepare(`
        SELECT r.status, COUNT(*) c FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE ${inviteWhere} GROUP BY r.status
      `).all() as any[]
      const inviteRecent = db.prepare(`
        SELECT s.name AS storeName, t.name AS taskName, r.status, r.error_code, r.status_reason, r.started_at, r.finished_at
        FROM task_runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN stores s ON s.id = r.store_id
        WHERE ${inviteWhere} ORDER BY r.rowid DESC LIMIT 10
      `).all() as any[]

      // 任务运行（近 7 天）状态分布 + 最近失败
      const runsByStatus = db.prepare(
        'SELECT status, COUNT(*) c FROM task_runs WHERE started_at > ? GROUP BY status'
      ).all(weekAgo) as any[]
      const recentIssues = db.prepare(`
        SELECT s.name AS storeName, t.name AS taskName, r.status, r.error_code, r.error_message, r.finished_at
        FROM task_runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN stores s ON s.id = r.store_id
        WHERE r.status IN ('failed','cancelled') ORDER BY r.rowid DESC LIMIT 8
      `).all() as any[]

      return success({
        generatedAt: Date.now(),
        totals,
        byPlatform,
        snapshots,
        invite: { byStatus: inviteByStatus, recent: inviteRecent },
        runs: { byStatus: runsByStatus, recentIssues }
      }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // settings:get / settings:set
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_e: IpcMainInvokeEvent, input: { key: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(input.key) as any
      return success({ key: input.key, value: row ? JSON.parse(row.value_json) : null }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_e: IpcMainInvokeEvent, input: { key: string, value: any }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      getDatabase().prepare(`
        INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(input.key, JSON.stringify(input.value), Date.now())
      return success({ success: true }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // audit:query - §6.7
  ipcMain.handle(IPC_CHANNELS.AUDIT_QUERY, async (_e: IpcMainInvokeEvent, input: { filter?: any }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      return success(queryAudit(input?.filter || {}), requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })

  // window:setTitlebarOverlay - §17 顶部融合：右上角原生窗口按钮（WCO）的
  // 底色随 UI 状态切换（欢迎页 #1a1a1a / 工作台 #242424 / 应用锁 #101218）。
  // 纯装饰通道：锁定门禁已放行（bg-services ALLOW_WHEN_LOCKED）。
  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY, async (e: IpcMainInvokeEvent, input: { color?: string, symbolColor?: string }): Promise<IPCResult> => {
    const requestId = generateRequestId()
    try {
      const HEX = /^#[0-9a-fA-F]{6}$/
      const overlay: Record<string, string> = {}
      if (input?.color && HEX.test(input.color)) overlay.color = input.color
      if (input?.symbolColor && HEX.test(input.symbolColor)) overlay.symbolColor = input.symbolColor
      if (Object.keys(overlay).length === 0) {
        return error(ERROR_CODES.INVALID_ARGUMENT.code, 'color/symbolColor 必须是 #RRGGBB', requestId)
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || win.isDestroyed()) {
        return error(ERROR_CODES.INTERNAL_ERROR.code, 'Window not available', requestId)
      }
      win.setTitleBarOverlay(overlay as Electron.TitleBarOverlay)
      return success({ applied: overlay }, requestId)
    } catch (err: any) {
      return error(ERROR_CODES.INTERNAL_ERROR.code, err.message, requestId)
    }
  })
}
