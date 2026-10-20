import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 定时邀约（2026-10-20）的真实 SQLite 测试。
 *
 * 钉住五件事：
 *   1. 排期窗口校验（过去时间/超过 30 天都不给建批次）；
 *   2. 建排期批次：**不立即入队**，任务先建好，状态 scheduled；
 *   3. 到点才拉起，且早到的时间点不会提前跑；
 *   4. 取消排期后不再被拉起；
 *   5. 到点复核：任务被删 / 额度不足 → 标失败并写原因，不产生"永远排期"。
 */
const require_ = createRequire(import.meta.url)
const DatabaseSyncCtor = (() => {
  try { return (require_('node:sqlite') as { DatabaseSync?: new (path: string) => any }).DatabaseSync ?? null } catch { return null }
})()

const state = vi.hoisted(() => ({ db: null as any, tasks: new Map<string, any>(), openStores: [] as string[], attachShouldFail: false }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => state.db }))
vi.mock('../../apps/desktop/src/main/browser/window-manager', () => ({ getOpenStoreIds: () => state.openStores }))
vi.mock('../../apps/desktop/src/main/tasks/task-store', () => ({
  createTask: vi.fn((input: any) => {
    const task = { id: `task_${state.tasks.size + 1}`, ...input }
    state.tasks.set(task.id, task)
    return task
  }),
  getTask: vi.fn((id: string) => state.tasks.get(id) ?? null),
  getRun: vi.fn((id: string) => ({ id, status: 'queued' }))
}))
vi.mock('../../apps/desktop/src/main/tasks/task-runner', () => ({
  enqueueRun: vi.fn((taskId: string) => ({ runId: `run_${taskId}`, storeId: 's1' }))
}))
// attach 可注入失败：钉住「run 已入队后，后续步骤失败不得把批次谎报成 failed」（审查 P1-5）
vi.mock('../../apps/desktop/src/main/services/invite-campaigns', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    attachInviteCampaignRun: (...args: any[]) => {
      if (state.attachShouldFail) throw new Error('attach boom（注入）')
      return actual.attachInviteCampaignRun(...args)
    }
  }
})

import {
  fireDueInviteCampaigns,
  startInviteCampaign
} from '../../apps/desktop/src/main/services/invite-campaign-service'
import { cancelScheduledInviteCampaign, listInviteCampaigns } from '../../apps/desktop/src/main/services/invite-campaigns'
import * as Runner from '../../apps/desktop/src/main/tasks/task-runner'

function makeDb(): any {
  const raw = new DatabaseSyncCtor!(':memory:')
  raw.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT, platform TEXT, deleted_at INTEGER);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE invite_records (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, campaign_id TEXT, invited_at INTEGER, status TEXT NOT NULL
    );
    CREATE TABLE invite_campaigns (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, filters_json TEXT, script_snapshot TEXT, product_ids_json TEXT,
      target_count INTEGER NOT NULL, daily_cap INTEGER, send_mode TEXT NOT NULL, created_by TEXT NOT NULL,
      task_id TEXT, run_id TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, stats_json TEXT,
      scheduled_at INTEGER, status_reason TEXT
    );
    CREATE TABLE task_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_id TEXT);
    CREATE TABLE invite_events (
      id TEXT PRIMARY KEY, store_id TEXT, campaign_id TEXT, record_id TEXT, run_id TEXT,
      type TEXT NOT NULL, payload_json TEXT, at INTEGER NOT NULL
    );
    INSERT INTO stores VALUES ('s1', '测试抖店', '抖店', NULL);
  `)
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    close: () => raw.close()
  }
}

function startInput(scheduleAt?: number) {
  return {
    task: {
      name: '达人邀约 · 抖店 · 定时',
      storeScope: 's1',
      steps: [{ type: 'waitMs', input: { ms: 10 }, timeoutMs: 1000 }]
    },
    campaign: { storeId: 's1', targetCount: 2, createdBy: 'panel', ...(scheduleAt ? { scheduleAt } : {}) }
  } as any
}

describe('定时邀约：排期、到点拉起、取消与到点复核（真实 SQLite + mock 引擎）', () => {
  const realIt = DatabaseSyncCtor ? it : it.skip

  beforeEach(() => {
    state.db = makeDb()
    state.tasks = new Map()
    state.openStores = []
    state.attachShouldFail = false
    vi.mocked(Runner.enqueueRun).mockClear()
  })
  afterEach(() => { try { state.db?.close() } catch { /* ignore */ } })

  realIt('过去时间 → 拒绝，不建批次', () => {
    const result = startInviteCampaign(startInput(Date.now() - 60_000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('1 分钟')
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM invite_campaigns').get().n).toBe(0)
  })

  realIt('超过 30 天 → 拒绝', () => {
    const result = startInviteCampaign(startInput(Date.now() + 31 * 24 * 60 * 60 * 1000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('30 天')
  })

  realIt('未来时间 → 建排期批次：status=scheduled、有任务、无 run、不入队', () => {
    const at = Date.now() + 10 * 60 * 1000
    const result = startInviteCampaign(startInput(at))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scheduledAt).toBe(at)
    expect(result.run).toBeNull()
    expect(Runner.enqueueRun).not.toHaveBeenCalled()

    const row = state.db.prepare('SELECT * FROM invite_campaigns WHERE id = ?').get(result.campaignId)
    expect(row.status).toBe('scheduled')
    expect(row.scheduled_at).toBe(at)
    expect(row.task_id).toBe(result.task.id)
    const event = state.db.prepare("SELECT * FROM invite_events WHERE type = 'campaign.scheduled'").get()
    expect(event.campaign_id).toBe(result.campaignId)
    expect(listInviteCampaigns({ storeId: 's1' })[0].status).toBe('scheduled')
  })

  realIt('未到点不拉起；到点拉起一次并写事件', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')

    expect(fireDueInviteCampaigns(at - 1).fired).toBe(0)
    expect(state.db.prepare("SELECT status FROM invite_campaigns WHERE id = ?").get(started.campaignId).status).toBe('scheduled')

    const fired = fireDueInviteCampaigns(at)
    expect(fired.fired).toBe(1)
    const row = state.db.prepare('SELECT * FROM invite_campaigns WHERE id = ?').get(started.campaignId)
    expect(row.status).toBe('running')
    expect(row.run_id).toBe(`run_${started.task.id}`)
    expect(Runner.enqueueRun).toHaveBeenCalledWith(started.task.id, { reason: '达人邀约（定时）', storeId: 's1' })
    const event = state.db.prepare("SELECT * FROM invite_events WHERE type = 'campaign.schedule_fired'").get()
    expect(event.campaign_id).toBe(started.campaignId)
    expect(JSON.parse(event.payload_json).lateMs).toBe(0)
  })

  realIt('取消排期 → 状态 stopped，到点也不会被拉起', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    expect(cancelScheduledInviteCampaign(started.campaignId)).toBe(true)
    expect(fireDueInviteCampaigns(at).fired).toBe(0)
    expect(state.db.prepare('SELECT status FROM invite_campaigns WHERE id = ?').get(started.campaignId).status).toBe('stopped')
    // 已启动/已取消的批次再取消一次必须是 false（不覆盖 running/failed 状态）
    expect(cancelScheduledInviteCampaign(started.campaignId)).toBe(false)
  })

  realIt('到点时任务已被删除 → 标失败并写原因', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    state.tasks.delete(started.task.id)

    const fired = fireDueInviteCampaigns(at)
    expect(fired.failed).toBe(1)
    const row = state.db.prepare('SELECT status, status_reason FROM invite_campaigns WHERE id = ?').get(started.campaignId)
    expect(row.status).toBe('failed')
    expect(row.status_reason).toContain('任务已被删除')
    expect(Runner.enqueueRun).not.toHaveBeenCalled()
  })

  realIt('到点复核额度：日上限不足 → 标失败并写明额度，不启动', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    // 排期创建之后用户把日上限改小（模拟跨天/改配置）
    state.db.prepare("INSERT INTO app_settings VALUES ('invite.config.store.s1', ?)")
      .run(JSON.stringify({ dailyCap: 1 }))

    const fired = fireDueInviteCampaigns(at)
    expect(fired.failed).toBe(1)
    const row = state.db.prepare('SELECT status, status_reason FROM invite_campaigns WHERE id = ?').get(started.campaignId)
    expect(row.status).toBe('failed')
    expect(String(row.status_reason)).toContain('额度不足')
    expect(Runner.enqueueRun).not.toHaveBeenCalled()
  })

  realIt('同店已有运行中批次 → 本次延后，不丢排期', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    state.db.prepare(`INSERT INTO invite_campaigns (
      id, store_id, platform, name, status, target_count, send_mode, created_by, task_id, run_id, created_at
    ) VALUES ('camp_busy','s1','抖店','忙碌批次','running',1,'direct','panel','t_busy','r_busy',?)`).run(Date.now())
    state.db.prepare("INSERT INTO task_runs VALUES ('r_busy','running','t_busy')").run()

    const fired = fireDueInviteCampaigns(at)
    expect(fired.deferred).toBe(1)
    expect(fired.fired).toBe(0)
    expect(state.db.prepare('SELECT status FROM invite_campaigns WHERE id = ?').get(started.campaignId).status).toBe('scheduled')
  })

  realIt('任务被手动直跑（现行 run 不挂在任何批次上）→ 到点延后而不是白白标失败（审查 P1-4）', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    // 模拟用户绕过批次创建、在任务列表手动直跑同一任务：现行 run 不属于任何 campaign
    state.db.prepare("INSERT INTO task_runs VALUES ('r_manual','running', NULL)").run()
    // 手动 run 与排期任务同一个 task_id（夹具的 task-store mock 用自增 id，这里直接对齐）
    const taskId = String(started.task.id)
    state.db.prepare("UPDATE task_runs SET task_id = ? WHERE id = 'r_manual'").run(taskId)

    const fired = fireDueInviteCampaigns(at)
    expect(fired.deferred).toBe(1)
    expect(fired.failed).toBe(0)
    expect(state.db.prepare('SELECT status FROM invite_campaigns WHERE id = ?').get(started.campaignId).status).toBe('scheduled')
    expect(Runner.enqueueRun).not.toHaveBeenCalled()
  })

  realIt('任务被手动直跑超过 2 小时 → 放弃排期并写明「手动运行」原因', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    const taskId = String(started.task.id)
    state.db.prepare("INSERT INTO task_runs VALUES ('r_manual','running', ?)").run(taskId)

    const fired = fireDueInviteCampaigns(at + 2 * 60 * 60 * 1000 + 1000)
    expect(fired.failed).toBe(1)
    const row = state.db.prepare('SELECT status, status_reason FROM invite_campaigns WHERE id = ?').get(started.campaignId)
    expect(row.status).toBe('failed')
    expect(String(row.status_reason)).toContain('手动运行')
    expect(Runner.enqueueRun).not.toHaveBeenCalled()
  })

  realIt('fire 时 enqueue 成功但关联失败 → 批次按 running 继续，不谎报失败（审查 P1-5）', () => {
    const at = Date.now() + 10 * 60 * 1000
    const started = startInviteCampaign(startInput(at))
    if (!started.ok) throw new Error('排期创建失败')
    state.attachShouldFail = true

    const fired = fireDueInviteCampaigns(at)
    expect(fired.fired).toBe(1)
    expect(fired.failed).toBe(0)
    // run 已入队（enqueueRun 被调过），批次状态如实跟任务走：running 而不是 failed
    expect(Runner.enqueueRun).toHaveBeenCalledWith(started.task.id, { reason: '达人邀约（定时）', storeId: 's1' })
    expect(state.db.prepare('SELECT status FROM invite_campaigns WHERE id = ?').get(started.campaignId).status).toBe('running')
  })
})
