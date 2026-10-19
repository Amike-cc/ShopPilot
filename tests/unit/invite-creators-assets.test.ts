import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 达人库 / 话术库 / 商品集的真实 SQL 测试。
 * 重点锁三件事：
 *   · upsert 不覆盖人工黑名单/标签；
 *   · 旧 invite_records 能回填达人库，且不覆盖已有 profile；
 *   · 资产按店铺隔离，删除是硬删。
 */
const require_ = createRequire(import.meta.url)
const DatabaseSyncCtor = (() => {
  try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => any }).DatabaseSync ?? null } catch { return null }
})()

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => state.db }))

import { backfillCreators, listBlacklistedNicknames, listCreators, updateCreator, upsertCreatorFromRecord } from '../../apps/desktop/src/main/services/invite-creators'
import { deleteInviteProductSet, deleteInviteScript, listInviteProductSets, listInviteScripts, saveInviteProductSet, saveInviteScript } from '../../apps/desktop/src/main/services/invite-assets'

function makeDb(): any {
  const raw = new DatabaseSyncCtor!(':memory:')
  raw.exec(`
    CREATE TABLE invite_records (
      id TEXT PRIMARY KEY, campaign_id TEXT, store_id TEXT NOT NULL, platform TEXT NOT NULL,
      creator_key TEXT NOT NULL, identity_level TEXT NOT NULL, nickname TEXT NOT NULL,
      finder_username TEXT, avatar_url TEXT, status TEXT NOT NULL, status_source TEXT NOT NULL,
      status_reason TEXT, script_text TEXT, product_ids_json TEXT, task_id TEXT, run_id TEXT,
      invited_at INTEGER, status_updated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE creator_profiles (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, creator_key TEXT NOT NULL,
      identity_level TEXT NOT NULL, nickname TEXT NOT NULL, finder_username TEXT, avatar_url TEXT,
      categories_json TEXT, level TEXT, sales_tier TEXT, follower_count INTEGER, metrics_json TEXT,
      tags_json TEXT, note TEXT, blacklisted INTEGER NOT NULL DEFAULT 0, blacklist_reason TEXT,
      last_status TEXT, last_invited_at INTEGER, invite_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      UNIQUE(store_id, platform, creator_key)
    );
    CREATE TABLE invite_scripts (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual', template TEXT NOT NULL, variables_json TEXT, max_len INTEGER,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE invite_product_sets (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL,
      product_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  return { exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql), close: () => raw.close() }
}

describe('达人库与邀约资产（真实 SQLite）', () => {
  const realIt = DatabaseSyncCtor ? it : it.skip
  beforeEach(() => { state.db = makeDb() })
  afterEach(() => { try { state.db?.close() } catch { /* ignore */ } })

  realIt('upsert 累计邀约次数，但保留人工黑名单/标签', () => {
    const base = { storeId: 's1', platform: '抖店', creatorKey: 'n:力哥', identityLevel: 'nickname' as const, nickname: '力哥', status: 'sent' }
    upsertCreatorFromRecord({ ...base, invitedAt: 1000 })
    upsertCreatorFromRecord({ ...base, invitedAt: 2000 })
    let rows = listCreators({ storeId: 's1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ nickname: '力哥', inviteCount: 2, blacklisted: false })
    updateCreator({ storeId: 's1', platform: '抖店', creatorKey: 'n:力哥', blacklisted: true, tags: ['高转化'], note: '重点' })
    upsertCreatorFromRecord({ ...base, invitedAt: 3000 })
    rows = listCreators({ storeId: 's1' })
    expect(rows[0]).toMatchObject({ inviteCount: 3, blacklisted: true, tags: ['高转化'], note: '重点' })
    expect(listBlacklistedNicknames('s1', '抖店')).toEqual(['力哥'])
    expect(listCreators({ storeId: 's1', blacklisted: true })).toHaveLength(1)
    expect(listCreators({ storeId: 's1', blacklisted: false })).toHaveLength(0)
  })

  realIt('旧记录回填达人不覆盖已有黑名单', () => {
    state.db.prepare(`
      INSERT INTO invite_records (id, store_id, platform, creator_key, identity_level, nickname, status, status_source, invited_at, created_at, updated_at)
      VALUES ('r1','s1','抖店','n:九零后','nickname','九零后','sent','local',5000,5000,5000)
    `).run()
    backfillCreators('s1')
    expect(listCreators({ storeId: 's1' }).map(row => row.nickname)).toContain('九零后')
    updateCreator({ storeId: 's1', platform: '抖店', creatorKey: 'n:九零后', blacklisted: true })
    backfillCreators('s1')
    expect(listCreators({ storeId: 's1' })[0].blacklisted).toBe(true)
  })

  realIt('话术/商品集按店铺隔离，删除是硬删', () => {
    const script = saveInviteScript({ storeId: 's1', platform: '抖店', name: '高佣版', template: '你好，合作一下', mode: 'manual' })!
    expect(script.name).toBe('高佣版')
    expect(listInviteScripts({ storeId: 's1', platform: '抖店' })).toHaveLength(1)
    expect(listInviteScripts({ storeId: 's2' })).toHaveLength(0)
    expect(deleteInviteScript(script.id, 's1')).toBe(true)
    expect(listInviteScripts({ storeId: 's1' })).toHaveLength(0)

    const set = saveInviteProductSet({ storeId: 's1', platform: '抖店', name: '主推', productIds: ['1001', '1002', '1001'] })!
    expect(set.productIds).toEqual(['1001', '1002'])
    expect(listInviteProductSets({ storeId: 's1' })[0].name).toBe('主推')
    expect(deleteInviteProductSet(set.id, 's1')).toBe(true)
    expect(listInviteProductSets({ storeId: 's1' })).toHaveLength(0)
  })
})
