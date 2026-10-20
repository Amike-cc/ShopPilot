/**
 * 达人库（2026-10-19，v2 P3）。
 *
 * 数据来源只有两个，都是真实发生过的：
 *   1. 引擎写 invite_records 时同步 upsert（昵称/身份/最近状态/邀约次数）；
 *   2. 旧记录第一次打开达人库时回填（INSERT OR IGNORE，不覆盖黑名单/标签/备注）。
 *
 * 不做平台画像抓取：等级/类目/销售额只有在候选预览实测接入后才会有值；
 * 现在读不到就是 null，界面显示「—」。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import { logMain } from './logger'
import type { CreatorView } from '@shared/invite-campaign'
import type { InviteIdentityLevel } from '@shared/invite-identity'

export interface CreatorListInput {
  storeId?: string
  platform?: string
  query?: string
  blacklisted?: boolean
  limit?: number
}

export interface CreatorUpdateInput {
  storeId: string
  platform: string
  creatorKey: string
  tags?: string[]
  note?: string | null
  blacklisted?: boolean
  blacklistReason?: string | null
}

function safeTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 20) : []
  } catch { return [] }
}

function mapCreator(row: any): CreatorView {
  return {
    id: row.id,
    storeId: row.store_id,
    platform: row.platform,
    creatorKey: row.creator_key,
    identityLevel: row.identity_level === 'username' ? 'username' : 'nickname',
    nickname: row.nickname,
    finderUsername: row.finder_username ?? null,
    tags: safeTags(row.tags_json),
    note: row.note ?? null,
    blacklisted: Number(row.blacklisted) === 1,
    blacklistReason: row.blacklist_reason ?? null,
    lastStatus: row.last_status ?? null,
    lastInvitedAt: row.last_invited_at ?? null,
    inviteCount: Number(row.invite_count) || 0,
    firstSeenAt: Number(row.first_seen_at) || 0,
    lastSeenAt: Number(row.last_seen_at) || 0
  }
}

/** 引擎写了一条邀约记录后调用：新建/更新达人库，保留人工标签、备注、黑名单。 */
export function upsertCreatorFromRecord(input: {
  storeId: string
  platform: string
  creatorKey: string
  identityLevel: InviteIdentityLevel
  nickname: string
  finderUsername?: string | null
  status: string
  invitedAt: number
}): void {
  if (!input.storeId || !input.creatorKey || !input.nickname) return
  try {
    getDatabase().prepare(`
      INSERT INTO creator_profiles (
        id, store_id, platform, creator_key, identity_level, nickname, finder_username,
        tags_json, blacklisted, last_status, last_invited_at, invite_count, first_seen_at, last_seen_at
      ) VALUES (?,?,?,?,?,?,?,'[]',0,?,?,1,?,?)
      ON CONFLICT(store_id, platform, creator_key) DO UPDATE SET
        nickname = excluded.nickname,
        identity_level = excluded.identity_level,
        finder_username = COALESCE(excluded.finder_username, creator_profiles.finder_username),
        last_status = excluded.last_status,
        last_invited_at = excluded.last_invited_at,
        last_seen_at = excluded.last_seen_at,
        invite_count = creator_profiles.invite_count + 1
    `).run(
      `cp_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      input.storeId, input.platform, input.creatorKey, input.identityLevel, input.nickname,
      input.finderUsername || null, input.status, input.invitedAt, input.invitedAt, input.invitedAt
    )
  } catch (error) {
    // 达人库写失败不影响邀约记录本身
    logMain('warn', `[invite] 更新达人库失败 store=${input.storeId} key=${input.creatorKey}: ${String((error as Error)?.message || error)}`)
  }
}

/** 旧记录回填：只为还没有 profile 的 creator_key 建一行，绝不覆盖已有黑名单/标签/备注。 */
export function backfillCreators(storeId?: string): void {
  const db = getDatabase()
  const where = storeId ? 'WHERE r.store_id = ?' : ''
  const params = storeId ? [String(storeId)] : []
  try {
    db.prepare(`
      INSERT OR IGNORE INTO creator_profiles (
        id, store_id, platform, creator_key, identity_level, nickname, finder_username,
        tags_json, blacklisted, last_status, last_invited_at, invite_count, first_seen_at, last_seen_at
      )
      SELECT
        'cp_' || lower(hex(randomblob(8))),
        r.store_id, r.platform, r.creator_key, r.identity_level, r.nickname, r.finder_username,
        '[]', 0, r.status, COALESCE(r.invited_at, r.created_at), 1,
        COALESCE(r.invited_at, r.created_at), COALESCE(r.invited_at, r.created_at)
      FROM invite_records r
      ${where}
        ${where ? 'AND' : 'WHERE'} r.id = (
          SELECT r2.id FROM invite_records r2
          WHERE r2.store_id = r.store_id AND r2.platform = r.platform AND r2.creator_key = r.creator_key
          ORDER BY COALESCE(r2.invited_at, r2.created_at) DESC LIMIT 1
        )
    `).run(...params)
  } catch (error) {
    logMain('warn', `[invite] 回填达人库失败: ${String((error as Error)?.message || error)}`)
  }
}

export function listCreators(input: CreatorListInput = {}): CreatorView[] {
  const db = getDatabase()
  backfillCreators(input.storeId)
  const where: string[] = []
  const params: unknown[] = []
  if (input.storeId) { where.push('store_id = ?'); params.push(String(input.storeId)) }
  if (input.platform) { where.push('platform = ?'); params.push(String(input.platform)) }
  if (typeof input.blacklisted === 'boolean') { where.push('blacklisted = ?'); params.push(input.blacklisted ? 1 : 0) }
  const query = String(input.query || '').trim()
  if (query) { where.push('nickname LIKE ?'); params.push(`%${query.slice(0, 40)}%`) }
  const limit = Math.max(1, Math.min(500, Math.round(Number(input.limit) || 200)))
  try {
    const rows = db.prepare(`
      SELECT * FROM creator_profiles
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(last_invited_at, last_seen_at) DESC
      LIMIT ?
    `).all(...params, limit) as any[]
    return rows.map(mapCreator)
  } catch (error) {
    logMain('error', `[invite] 读取达人库失败: ${String((error as Error)?.message || error)}`)
    return []
  }
}

export function updateCreator(input: CreatorUpdateInput): CreatorView | null {
  const sets: string[] = []
  const params: unknown[] = []
  if (Array.isArray(input.tags)) {
    sets.push('tags_json = ?')
    params.push(JSON.stringify(input.tags.map(String).map(item => item.trim()).filter(Boolean).slice(0, 20)))
  }
  if (input.note !== undefined) {
    sets.push('note = ?')
    params.push(input.note ? String(input.note).slice(0, 1000) : null)
  }
  if (typeof input.blacklisted === 'boolean') {
    sets.push('blacklisted = ?')
    params.push(input.blacklisted ? 1 : 0)
  }
  if (input.blacklistReason !== undefined) {
    sets.push('blacklist_reason = ?')
    params.push(input.blacklistReason ? String(input.blacklistReason).slice(0, 300) : null)
  }
  if (!sets.length) return null
  sets.push('last_seen_at = ?')
  params.push(Date.now())
  try {
    getDatabase().prepare(`
      UPDATE creator_profiles SET ${sets.join(', ')}
      WHERE store_id = ? AND platform = ? AND creator_key = ?
    `).run(...params, input.storeId, input.platform, input.creatorKey)
    const row = getDatabase().prepare(`
      SELECT * FROM creator_profiles WHERE store_id = ? AND platform = ? AND creator_key = ?
    `).get(input.storeId, input.platform, input.creatorKey) as any
    return row ? mapCreator(row) : null
  } catch (error) {
    logMain('error', `[invite] 更新达人库失败: ${String((error as Error)?.message || error)}`)
    return null
  }
}

/** 开跑前取黑名单昵称：交给任务在选人阶段跳过（与 7 天台账同一个 skipTexts 口径）。 */
export function listBlacklistedNicknames(storeId: string, platform: string): string[] {
  if (!storeId) return []
  try {
    const rows = getDatabase().prepare(`
      SELECT nickname FROM creator_profiles
      WHERE store_id = ? AND platform = ? AND blacklisted = 1
      ORDER BY last_seen_at DESC LIMIT 500
    `).all(storeId, platform) as Array<{ nickname: string }>
    return rows.map(row => row.nickname).filter(Boolean)
  } catch { return [] }
}
