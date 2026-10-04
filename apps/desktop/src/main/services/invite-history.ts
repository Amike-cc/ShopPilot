/**
 * 邀约台账：谁在什么时候被邀过。
 *
 * 用途（用户要求：**7 天内邀过的达人不再重复邀约**）：
 *   · 开跑前查出"近 N 天已邀"的昵称清单 → 交给任务，点「详情」时**直接跳过**这些行（不花详情页访问）；
 *   · 平台的"7 天内不可再次邀请"作为兜底（点进详情页会看到按钮禁用 → TASK_DAREN_ALREADY_INVITED）。
 *
 * 为什么不依赖平台列表：2026-10-04 真机实测，广场列表行没有"已邀约"标记，
 * 详情链接是 `javascript:void(0)`，也拿不到 finderUsername。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import { logMain } from '../services/logger'

export interface InviteHistoryEntry {
  id: string
  storeId: string
  platform: string
  nickname: string
  finderUsername: string | null
  taskId: string | null
  runId: string | null
  invitedAt: number
}

/** 用户要求的重复邀约窗口（天） */
export const INVITE_REPEAT_WINDOW_DAYS = 7

/** 记一条邀约（昵称必填：跳过时就是拿它跟列表行比对） */
export function recordInvite(input: {
  storeId: string
  platform: string
  nickname: string
  finderUsername?: string | null
  taskId?: string | null
  runId?: string | null
  at?: number
}): InviteHistoryEntry | null {
  const nickname = String(input.nickname || '').trim()
  if (!input.storeId || !nickname) return null
  const entry: InviteHistoryEntry = {
    id: `inv_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    storeId: input.storeId,
    platform: String(input.platform || ''),
    nickname: nickname.slice(0, 120),
    finderUsername: input.finderUsername ? String(input.finderUsername).slice(0, 200) : null,
    taskId: input.taskId || null,
    runId: input.runId || null,
    invitedAt: input.at ?? Date.now()
  }
  try {
    getDatabase().prepare(`
      INSERT INTO invite_history (id, store_id, platform, nickname, finder_username, task_id, run_id, invited_at)
      VALUES (@id, @storeId, @platform, @nickname, @finderUsername, @taskId, @runId, @invitedAt)
    `).run(entry)
    logMain('info', `[invite] 已记入邀约台账 store=${entry.storeId} nickname=${entry.nickname} user=${entry.finderUsername || '-'}`)
    return entry
  } catch (err) {
    // 台账写失败不该打挂已经发出去的邀约：如实记一条 error，运行继续
    logMain('error', `[invite] 写邀约台账失败 store=${entry.storeId} nickname=${entry.nickname}: ${String((err as Error)?.message || err)}`)
    return null
  }
}

/** 近 N 天（默认 7）已邀过的**昵称**清单：交给任务用于点「详情」前跳过 */
export function recentInvitedNicknames(storeId: string, days = INVITE_REPEAT_WINDOW_DAYS): string[] {
  if (!storeId) return []
  const since = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000
  try {
    const rows = getDatabase()
      .prepare('SELECT DISTINCT nickname FROM invite_history WHERE store_id = ? AND invited_at >= ? ORDER BY invited_at DESC LIMIT 500')
      .all(storeId, since) as Array<{ nickname: string }>
    return rows.map(r => r.nickname).filter(Boolean)
  } catch {
    return []
  }
}

/** 台账明细（面板/排查用） */
export function listInvites(storeId: string, limit = 50): InviteHistoryEntry[] {
  try {
    return getDatabase()
      .prepare('SELECT id, store_id AS storeId, platform, nickname, finder_username AS finderUsername, task_id AS taskId, run_id AS runId, invited_at AS invitedAt FROM invite_history WHERE store_id = ? ORDER BY invited_at DESC LIMIT ?')
      .all(storeId, Math.max(1, Math.min(500, limit))) as InviteHistoryEntry[]
  } catch {
    return []
  }
}
