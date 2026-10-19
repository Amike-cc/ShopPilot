/**
 * 达人邀约审计事件（2026-10-19，v2 P4 最小实现）。
 *
 * 只记**会改变状态/资产**的动作：批次启动、达人黑名单/标签修改、话术/商品集保存。
 * 不记每次读取；payload 里不写联系方式（配置快照已单独脱敏）。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import { logMain } from './logger'

export function recordInviteEvent(input: {
  storeId?: string | null
  campaignId?: string | null
  recordId?: string | null
  runId?: string | null
  type: string
  payload?: Record<string, unknown> | null
}): void {
  try {
    getDatabase().prepare(`
      INSERT INTO invite_events (id, store_id, campaign_id, record_id, run_id, type, payload_json, at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      `iev_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      input.storeId || null, input.campaignId || null, input.recordId || null, input.runId || null,
      String(input.type || 'unknown').slice(0, 80),
      input.payload ? JSON.stringify(input.payload).slice(0, 4000) : null,
      Date.now()
    )
  } catch (error) {
    // 审计写失败不影响主流程
    logMain('warn', `[invite] 写审计事件失败 type=${input.type}: ${String((error as Error)?.message || error)}`)
  }
}
