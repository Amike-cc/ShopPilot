/**
 * 达人邀约逐人记录（2026-10-19，v2）。
 *
 * 为什么需要这张表：旧 `invite_history` 只记「谁在什么时候被邀过」，而且批量流
 * （抖店/快手）实际没有写入——`recordInvite` 只在 `pendingCreatorNickname` 存在时调用，
 * 该字段只有微信辅助流的 clickByText 会赋值。结果是「近 7 天已邀」对批量平台基本为空，
 * 面板的自动跳过提示失真，历史也无法回答「发给了谁、结果如何」。
 *
 * 本服务是**唯一写入口径**：
 *   · 引擎一轮成功后调用 `recordInviteBatch`，批量流一次写 N 位、辅助流写 1 位；
 *   · 同时双写旧 `invite_history`，保证旧面板的 recentInvitedNicknames 继续有效；
 *   · 幂等：新表 `(run_id, creator_key, invited_at)` 唯一，重试/恢复不会重复记账；
 *   · 读不到平台状态就是 `sent`/`unknown`，不推断「已接受/已过期」。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import { logMain } from './logger'
import { upsertCreatorFromRecord } from './invite-creators'
import { inviteCreatorKey } from '@shared/invite-identity'
import type {
  InviteRecordListInput,
  InviteRecordStatus,
  InviteRecordView,
  InviteStatusSource,
  InviteSummary
} from '@shared/invite-campaign'

export interface RecordInviteBatchInput {
  storeId: string
  platform: string
  names: string[]
  taskId?: string | null
  runId?: string | null
  campaignId?: string | null
  /** 一轮开始的时刻：同一轮重试复用同一个值，配合唯一索引做幂等 */
  invitedAt?: number
  status?: InviteRecordStatus
  statusSource?: InviteStatusSource
  statusReason?: string | null
  scriptText?: string | null
  productIds?: string[]
  /** 仅辅助流（一轮一位）能从详情页 URL 拿到稳定用户名 */
  finderUsername?: string | null
}

/**
 * 写一轮邀约结果。批量流：names = 本批实际勾选的全部昵称；辅助流：names = [昵称]。
 * 返回新插入的记录数（幂等重放时为 0）。
 */
export function recordInviteBatch(input: RecordInviteBatchInput): number {
  const names = [...new Set((input.names || [])
    .map(name => String(name || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(name => name.slice(0, 120)))]
  if (!input.storeId || !names.length) return 0

  const db = getDatabase()
  const at = Number.isFinite(input.invitedAt) ? Number(input.invitedAt) : Date.now()
  const status = input.status || 'sent'
  const statusSource = input.statusSource || 'local'
  const platform = String(input.platform || '').trim() || 'unknown'
  const productIdsJson = input.productIds?.length ? JSON.stringify(input.productIds.slice(0, 30)) : null
  let inserted = 0

  try {
    db.transaction(() => {
      for (const nickname of names) {
        const identity = inviteCreatorKey(nickname, names.length === 1 ? input.finderUsername : null)

        /**
         * 旧表双写：旧面板 `recentInvitedNicknames` 只读 invite_history。
         * 批量流此前完全不写，这里按「同一 run + 同一昵称」去重，避免恢复重跑重复插入。
         */
        const seen = input.runId
          ? db.prepare('SELECT 1 AS hit FROM invite_history WHERE run_id = ? AND nickname = ? LIMIT 1').get(input.runId, nickname)
          : null
        if (!seen) {
          db.prepare(`
            INSERT INTO invite_history (id, store_id, platform, nickname, finder_username, task_id, run_id, invited_at)
            VALUES (?,?,?,?,?,?,?,?)
          `).run(
            `inv_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            input.storeId, platform, nickname,
            input.finderUsername || null, input.taskId || null, input.runId || null, at
          )
        }

        const result = db.prepare(`
          INSERT OR IGNORE INTO invite_records (
            id, campaign_id, store_id, platform, creator_key, identity_level, nickname, finder_username,
            status, status_source, status_reason, script_text, product_ids_json,
            task_id, run_id, invited_at, status_updated_at, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          `rec_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          input.campaignId || null, input.storeId, platform,
          identity.key, identity.level, nickname,
          input.finderUsername || null,
          status, statusSource, input.statusReason || null,
          input.scriptText ? String(input.scriptText).slice(0, 2000) : null,
          productIdsJson,
          input.taskId || null, input.runId || null,
          at, at, Date.now(), Date.now()
        )
        const changed = Number(result.changes || 0)
        inserted += changed
        if (changed > 0) {
          // 达人库只在新记录落库时 +1；幂等重放不重复累计邀约次数
          upsertCreatorFromRecord({
            storeId: input.storeId,
            platform,
            creatorKey: identity.key,
            identityLevel: identity.level,
            nickname,
            finderUsername: input.finderUsername || null,
            status,
            invitedAt: at
          })
        }
      }
    })()
    logMain('info', `[invite] 已记录 ${inserted}/${names.length} 位达人 store=${input.storeId} run=${input.runId || '-'} status=${status}`)
    return inserted
  } catch (error) {
    // 写记录失败不该打挂已经发出的邀约：如实记 error，运行继续
    logMain('error', `[invite] 写逐人记录失败 store=${input.storeId} run=${input.runId || '-'}: ${String((error as Error)?.message || error)}`)
    return 0
  }
}

function parseProducts(raw: unknown): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 30) : []
  } catch {
    return []
  }
}

function mapRecordRow(row: any): InviteRecordView {
  return {
    id: row.id,
    campaignId: row.campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    storeId: row.store_id,
    storeName: row.store_name ?? null,
    platform: row.platform,
    creatorKey: row.creator_key,
    identityLevel: row.identity_level === 'username' ? 'username' : 'nickname',
    nickname: row.nickname,
    finderUsername: row.finder_username ?? null,
    status: row.status as InviteRecordStatus,
    statusSource: (['local', 'platform', 'manual'].includes(String(row.status_source)) ? row.status_source : 'local') as InviteStatusSource,
    statusReason: row.status_reason ?? null,
    scriptText: row.script_text ?? null,
    productIds: parseProducts(row.product_ids_json),
    taskId: row.task_id ?? null,
    runId: row.run_id ?? null,
    invitedAt: row.invited_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 人工修正状态（平台状态回读未接入时的兜底）。
 * 只允许人工可判断的几档；写 status_source='manual' 留痕，不冒充平台回读。
 */
export function updateInviteRecordStatus(input: { id: string; storeId: string; status: InviteRecordStatus; reason?: string | null }): boolean {
  const allowed: InviteRecordStatus[] = ['sent', 'inviting', 'accepted', 'rejected', 'expired', 'unknown']
  if (!input.id || !input.storeId || !allowed.includes(input.status)) return false
  try {
    const result = getDatabase().prepare(`
      UPDATE invite_records
      SET status = ?, status_source = 'manual', status_reason = ?, status_updated_at = ?, updated_at = ?
      WHERE id = ? AND store_id = ?
    `).run(input.status, input.reason ? String(input.reason).slice(0, 300) : '人工修正', Date.now(), Date.now(), input.id, input.storeId)
    return Number(result.changes) > 0
  } catch (error) {
    logMain('error', `[invite] 人工修正状态失败: ${String((error as Error)?.message || error)}`)
    return false
  }
}

export function listInviteRecords(input: InviteRecordListInput = {}): InviteRecordView[] {
  const db = getDatabase()
  const where: string[] = []
  const params: unknown[] = []
  if (input.storeId) { where.push('r.store_id = ?'); params.push(String(input.storeId)) }
  if (input.campaignId) { where.push('r.campaign_id = ?'); params.push(String(input.campaignId)) }
  if (input.status) { where.push('r.status = ?'); params.push(String(input.status)) }
  const limit = Math.max(1, Math.min(500, Math.round(Number(input.limit) || 100)))
  const offset = Math.max(0, Math.round(Number(input.offset) || 0))
  const sql = `
    SELECT r.*, c.name AS campaign_name, s.name AS store_name
    FROM invite_records r
    LEFT JOIN invite_campaigns c ON c.id = r.campaign_id
    LEFT JOIN stores s ON s.id = r.store_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(r.invited_at, r.created_at) DESC, r.created_at DESC
    LIMIT ? OFFSET ?
  `
  try {
    return (db.prepare(sql).all(...params, limit, offset) as any[]).map(mapRecordRow)
  } catch (error) {
    logMain('error', `[invite] 读取逐人记录失败: ${String((error as Error)?.message || error)}`)
    return []
  }
}

/** 「已发送」只算本地确认或平台回读到已发出的状态；unknown 单独计数，不能冒充满意度。 */
const SENT_STATUSES = "('sent','inviting','accepted','rejected','expired')"

export function inviteRecordSummary(storeId?: string): InviteSummary {
  const db = getDatabase()
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const recent = Date.now() - 7 * 24 * 60 * 60 * 1000
  const where = storeId ? 'WHERE store_id = ?' : ''
  const params = storeId ? [dayStart.getTime(), recent, String(storeId)] : [dayStart.getTime(), recent]
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN invited_at >= ? AND status IN ${SENT_STATUSES} THEN 1 ELSE 0 END), 0) AS todaySent,
        COALESCE(SUM(CASE WHEN invited_at >= ? AND status IN ${SENT_STATUSES} THEN 1 ELSE 0 END), 0) AS recentSent,
        COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
        COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown
      FROM invite_records ${where}
    `).get(...params) as any
    return {
      todaySent: Number(row?.todaySent) || 0,
      recentSent: Number(row?.recentSent) || 0,
      accepted: Number(row?.accepted) || 0,
      rejected: Number(row?.rejected) || 0,
      unknown: Number(row?.unknown) || 0,
      total: Number(row?.total) || 0
    }
  } catch (error) {
    logMain('error', `[invite] 汇总逐人记录失败: ${String((error as Error)?.message || error)}`)
    return { todaySent: 0, recentSent: 0, accepted: 0, rejected: 0, unknown: 0, total: 0 }
  }
}

/** 批次列表用的轻量计数：一次 SQL 按状态分组，避免每个批次再查一遍。 */
export function inviteCountsByCampaign(campaignId: string): { sent: number; skipped: number; failed: number; unknown: number } {
  const db = getDatabase()
  const out = { sent: 0, skipped: 0, failed: 0, unknown: 0 }
  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM invite_records WHERE campaign_id = ? GROUP BY status').all(campaignId) as Array<{ status: string; n: number }>
    for (const row of rows) {
      const status = String(row.status || '')
      const n = Number(row.n) || 0
      if (['sent', 'inviting', 'accepted', 'rejected', 'expired'].includes(status)) out.sent += n
      else if (status.startsWith('skipped_')) out.skipped += n
      else if (status.startsWith('failed_')) out.failed += n
      else if (status === 'unknown') out.unknown += n
    }
  } catch { /* 读不到按 0，不虚报 */ }
  return out
}
