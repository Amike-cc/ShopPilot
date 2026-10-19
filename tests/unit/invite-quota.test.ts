import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 日额度台账：本地只做保守护栏——
 *   used = 今天已发出的记录；reserved = 今天仍在运行/排队的批次 target；
 *   limit = 店铺配置 dailyCap（0/缺省 = 不设上限）；
 *   不设上限时 remaining=null，启动永远放行（平台额度仍由引擎收尾）。
 */
const require_ = createRequire(import.meta.url)
const DatabaseSyncCtor = (() => {
  try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => any }).DatabaseSync ?? null } catch { return null }
})()

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => state.db }))

import { checkInviteQuota, getInviteQuota } from '../../apps/desktop/src/main/services/invite-quota'

function makeDb(): any {
  const raw = new DatabaseSyncCtor!(':memory:')
  raw.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE invite_records (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL,
      invited_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE invite_campaigns (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, target_count INTEGER NOT NULL,
      run_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE task_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `)
  return { exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql), close: () => raw.close() }
}

function insertRecord(raw: any, id: string, at: number, status = 'sent'): void {
  state.db.prepare('INSERT INTO invite_records (id, store_id, platform, status, invited_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, 's1', '抖店', status, at, at)
}

describe('达人邀约日额度', () => {
  const realIt = DatabaseSyncCtor ? it : it.skip
  beforeEach(() => { state.db = makeDb() })
  afterEach(() => { try { state.db?.close() } catch { /* ignore */ } })

  realIt('已发 + 运行中预留 + 店铺日上限：剩余与拦截都准确', () => {
    const today = Date.now()
    const yesterday = today - 24 * 60 * 60 * 1000
    insertRecord({}, 'r1', today)
    insertRecord({}, 'r2', today, 'accepted')
    insertRecord({}, 'r3', yesterday) // 昨天的不算今天
    insertRecord({}, 'r4', today, 'unknown') // 未确认不算已发
    state.db.prepare("INSERT INTO app_settings VALUES ('invite.config.store.s1', ?, 0)").run(JSON.stringify({ dailyCap: 10 }))
    state.db.prepare("INSERT INTO task_runs VALUES ('run_active', 'running')").run()
    state.db.prepare("INSERT INTO invite_campaigns VALUES ('c1','s1','抖店',5,'run_active',?)").run(today)
    state.db.prepare("INSERT INTO task_runs VALUES ('run_done', 'succeeded')").run()
    state.db.prepare("INSERT INTO invite_campaigns VALUES ('c2','s1','抖店',10,'run_done',?)").run(today)

    const quota = getInviteQuota('s1', '抖店')
    expect(quota).toMatchObject({ used: 2, reserved: 5, limit: 10, remaining: 3, source: 'config' })
    expect(checkInviteQuota('s1', '抖店', 3).ok).toBe(true)
    expect(checkInviteQuota('s1', '抖店', 4).ok).toBe(false)
  })

  realIt('未配置 dailyCap：只统计不拦截，remaining=null（不拿猜的默认值阻止用户）', () => {
    insertRecord({}, 'r1', Date.now())
    const quota = getInviteQuota('s1', '抖店')
    expect(quota.limit).toBeNull()
    expect(quota.remaining).toBeNull()
    expect(quota.used).toBe(1)
    expect(checkInviteQuota('s1', '抖店', 999).ok).toBe(true)
  })
})
