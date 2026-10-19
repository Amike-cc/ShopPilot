import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 逐人记录服务的真实 SQL 测试。
 *
 * 为什么值得单测：这条链路是「批量流有没有写台账」的修复核心——
 *   · recordInviteBatch 同时写 invite_history（旧面板 7 天去重）与 invite_records（新模块）；
 *   · (run_id, creator_key, invited_at) 唯一索引保证重跑不重复；
 *   · 用户名优先、昵称兜底的身份规则。
 * 用 node:sqlite 而不是 better-sqlite3：后者在本仓库是为 Electron ABI 编译的，
 * 纯 Node 下加载会 ERR_DLOPEN_FAILED（与 migrations.test.ts 同一口径）。
 */
const require_ = createRequire(import.meta.url)
const DatabaseSyncCtor = (() => {
  try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => any }).DatabaseSync ?? null } catch { return null }
})()

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => state.db }))

import { inviteCountsByCampaign, inviteRecordSummary, listInviteRecords, recordInviteBatch, updateInviteRecordStatus } from '../../apps/desktop/src/main/services/invite-records'

function makeDb(): any {
  const raw = new DatabaseSyncCtor!(':memory:')
  raw.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE invite_campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE invite_history (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, nickname TEXT NOT NULL,
      finder_username TEXT, task_id TEXT, run_id TEXT, invited_at INTEGER NOT NULL
    );
    CREATE TABLE invite_records (
      id TEXT PRIMARY KEY, campaign_id TEXT, store_id TEXT NOT NULL, platform TEXT NOT NULL,
      creator_key TEXT NOT NULL, identity_level TEXT NOT NULL, nickname TEXT NOT NULL,
      finder_username TEXT, avatar_url TEXT, status TEXT NOT NULL, status_source TEXT NOT NULL,
      status_reason TEXT, script_text TEXT, product_ids_json TEXT, task_id TEXT, run_id TEXT,
      invited_at INTEGER, status_updated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_invite_records_idem ON invite_records(run_id, creator_key, invited_at);
    INSERT INTO stores VALUES ('s1', '测试店');
    INSERT INTO invite_campaigns VALUES ('c1', '测试批次');
  `)
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    close: () => raw.close(),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      raw.exec('BEGIN')
      try {
        const result = fn(...args)
        raw.exec('COMMIT')
        return result
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    }
  }
}

describe('逐人邀约记录服务（真实 SQLite）', () => {
  const realIt = DatabaseSyncCtor ? it : it.skip

  beforeEach(() => { state.db = makeDb() })
  afterEach(() => { try { state.db?.close() } catch { /* ignore */ } })

  realIt('批量写 N 位：旧台账与新记录同时落库，重放幂等', () => {
    const at = new Date('2026-10-19T10:00:00+08:00').getTime()
    const first = recordInviteBatch({
      storeId: 's1', platform: '抖店', campaignId: 'c1', taskId: 't1', runId: 'r1',
      names: ['力哥', '九零后老母亲', '力哥'], invitedAt: at
    })
    expect(first).toBe(2)
    const second = recordInviteBatch({
      storeId: 's1', platform: '抖店', campaignId: 'c1', taskId: 't1', runId: 'r1',
      names: ['力哥', '九零后老母亲'], invitedAt: at
    })
    expect(second).toBe(0)

    const records = listInviteRecords({ storeId: 's1' })
    expect(records).toHaveLength(2)
    expect(records.map(r => r.nickname).sort()).toEqual(['九零后老母亲', '力哥'])
    expect(records.every(r => r.status === 'sent' && r.statusSource === 'local')).toBe(true)
    expect(records.every(r => r.identityLevel === 'nickname')).toBe(true)
    expect(inviteCountsByCampaign('c1')).toMatchObject({ sent: 2, skipped: 0, failed: 0, unknown: 0 })

    const legacy = state.db.prepare('SELECT COUNT(*) AS n FROM invite_history').get() as { n: number }
    expect(legacy.n).toBe(2)
  })

  realIt('辅助流单条：有 finderUsername 时用用户名身份', () => {
    recordInviteBatch({
      storeId: 's1', platform: '微信小店', runId: 'r2', invitedAt: Date.now(),
      names: ['力哥'], finderUsername: 'finder_123'
    })
    const record = listInviteRecords({ storeId: 's1' })[0]
    expect(record.creatorKey).toBe('u:finder_123')
    expect(record.identityLevel).toBe('username')
    expect(record.finderUsername).toBe('finder_123')
  })

  realIt('人工修正状态：只改指定记录，状态来源标 manual', () => {
    recordInviteBatch({ storeId: 's1', platform: '抖店', runId: 'r_manual', names: ['C'], invitedAt: Date.now() })
    const record = listInviteRecords({ storeId: 's1' })[0]
    expect(updateInviteRecordStatus({ id: record.id, storeId: 's1', status: 'accepted', reason: '人工核对' })).toBe(true)
    const updated = listInviteRecords({ storeId: 's1' })[0]
    expect(updated).toMatchObject({ status: 'accepted', statusSource: 'manual', statusReason: '人工核对' })
    expect(updateInviteRecordStatus({ id: record.id, storeId: 'other', status: 'accepted' })).toBe(false)
  })

  realIt('汇总只把已发出状态计入今日/近 7 天，unknown 单独计数', () => {
    const now = Date.now()
    recordInviteBatch({ storeId: 's1', platform: '抖店', runId: 'r3', names: ['A'], invitedAt: now, status: 'sent' })
    recordInviteBatch({ storeId: 's1', platform: '抖店', runId: 'r4', names: ['B'], invitedAt: now, status: 'unknown' })
    const summary = inviteRecordSummary('s1')
    expect(summary.todaySent).toBe(1)
    expect(summary.unknown).toBe(1)
    expect(summary.total).toBe(2)
  })
})
