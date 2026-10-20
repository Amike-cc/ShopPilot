import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 批次启动编排（P1 从 IPC 下沉后的服务）的真实 SQLite 测试。
 *
 * 钉住四件事：店铺不存在、同店运行锁、日额度、成功链路（批次→任务→run→事件）。
 * TaskStore/Runner 是 mock：本测试验证的是**编排决策**，不是任务引擎。
 */
const require_ = createRequire(import.meta.url)
const DatabaseSyncCtor = (() => {
  try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => any }).DatabaseSync ?? null } catch { return null }
})()

const state = vi.hoisted(() => ({ db: null as any, openStores: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => state.db }))
vi.mock('../../apps/desktop/src/main/browser/window-manager', () => ({ getOpenStoreIds: () => state.openStores }))
vi.mock('../../apps/desktop/src/main/tasks/task-store', () => ({
  createTask: vi.fn((input: any) => ({ id: 'task_1', ...input })),
  getRun: vi.fn(() => ({ id: 'run_1', status: 'queued' }))
}))
vi.mock('../../apps/desktop/src/main/tasks/task-runner', () => ({
  enqueueRun: vi.fn(() => ({ runId: 'run_1', storeId: 's1' }))
}))

import { startInviteCampaign } from '../../apps/desktop/src/main/services/invite-campaign-service'
import * as TaskStore from '../../apps/desktop/src/main/tasks/task-store'
import * as Runner from '../../apps/desktop/src/main/tasks/task-runner'

function makeDb(): any {
  const raw = new DatabaseSyncCtor!(':memory:')
  raw.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY, platform TEXT, deleted_at INTEGER);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE invite_records (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, invited_at INTEGER, status TEXT NOT NULL
    );
    CREATE TABLE invite_campaigns (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, filters_json TEXT, script_snapshot TEXT, product_ids_json TEXT,
      target_count INTEGER NOT NULL, daily_cap INTEGER, send_mode TEXT NOT NULL, created_by TEXT NOT NULL,
      task_id TEXT, run_id TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, stats_json TEXT,
      scheduled_at INTEGER, status_reason TEXT
    );
    CREATE TABLE task_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE invite_events (
      id TEXT PRIMARY KEY, store_id TEXT, campaign_id TEXT, record_id TEXT, run_id TEXT,
      type TEXT NOT NULL, payload_json TEXT, at INTEGER NOT NULL
    );
    INSERT INTO stores VALUES ('s1', '抖店', NULL);
  `)
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    close: () => raw.close()
  }
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      name: '达人邀约 · 抖店 · 测试',
      storeScope: 's1',
      steps: [{ type: 'waitMs', input: { ms: 10 }, timeoutMs: 1000 }]
    },
    campaign: { storeId: 's1', targetCount: 2, createdBy: 'panel' },
    ...overrides
  } as any
}

describe('达人邀约批次启动编排（真实 SQLite + mock 引擎）', () => {
  const realIt = DatabaseSyncCtor ? it : it.skip

  beforeEach(() => {
    state.db = makeDb()
    state.openStores = []
    vi.mocked(TaskStore.createTask).mockClear()
    vi.mocked(Runner.enqueueRun).mockClear()
  })
  afterEach(() => { try { state.db?.close() } catch { /* ignore */ } })

  realIt('店铺不存在 → 拒绝，不建批次', () => {
    const result = startInviteCampaign(startInput({ campaign: { storeId: 'nope', targetCount: 1 } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('店铺不存在')
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM invite_campaigns').get().n).toBe(0)
  })

  realIt('同店同平台已有进行中批次 → TASK_BAD_STATE，不建新批次', () => {
    state.db.prepare(`INSERT INTO invite_campaigns (
      id, store_id, platform, name, status, target_count, send_mode, created_by, task_id, run_id, created_at
    ) VALUES ('camp_old','s1','抖店','旧批次','running',1,'direct','panel','t_old','r_old',?)`).run(Date.now())
    state.db.prepare("INSERT INTO task_runs VALUES ('r_old','running')").run()

    const result = startInviteCampaign(startInput())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('TASK_BAD_STATE')
      expect(result.message).toContain('旧批次')
    }
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM invite_campaigns').get().n).toBe(1)
  })

  realIt('店铺日上限不足 → INVITE_QUOTA_EXCEEDED，不建批次', () => {
    state.db.prepare("INSERT INTO app_settings VALUES ('invite.config.store.s1', ?)")
      .run(JSON.stringify({ dailyCap: 1 }))
    const result = startInviteCampaign(startInput({ campaign: { storeId: 's1', targetCount: 2 } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVITE_QUOTA_EXCEEDED')
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM invite_campaigns').get().n).toBe(0)
  })

  realIt('成功：建批次 → 建任务 → 入队 → 关联 run → 写事件；店铺未打开时 waitingForStore=true', () => {
    const result = startInviteCampaign(startInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.campaignId).toMatch(/^camp_/)
    expect(result.waitingForStore).toBe(true)
    expect(result.task.kind).toBe('creator_invite')
    expect(result.task.campaignId).toBe(result.campaignId)

    const row = state.db.prepare('SELECT * FROM invite_campaigns WHERE id = ?').get(result.campaignId)
    expect(row.status).toBe('running')
    expect(row.task_id).toBe('task_1')
    expect(row.run_id).toBe('run_1')
    expect(row.target_count).toBe(2)

    const event = state.db.prepare("SELECT * FROM invite_events WHERE type = 'campaign.started'").get()
    expect(event.campaign_id).toBe(result.campaignId)
    expect(Runner.enqueueRun).toHaveBeenCalledWith('task_1', { reason: '达人邀约', storeId: 's1' })
  })

  realIt('店铺已打开 → waitingForStore=false', () => {
    state.openStores = ['s1']
    const result = startInviteCampaign(startInput())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.waitingForStore).toBe(false)
  })

  realIt('建任务失败 → 批次标记 failed（不留「有批次没运行」）', () => {
    vi.mocked(TaskStore.createTask).mockImplementationOnce(() => { throw new Error('TASK_INVALID_STEP: 步骤不合法') })
    expect(() => startInviteCampaign(startInput())).toThrow(/TASK_INVALID_STEP/)
    const row = state.db.prepare("SELECT status FROM invite_campaigns WHERE status = 'failed'").get()
    expect(row?.status).toBe('failed')
  })
})
