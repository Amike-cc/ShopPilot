import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { auditQueryFilterSchema } from '../../packages/shared/src/schemas/audit'

/**
 * 2026-09-26 审计 P2「审计关联键与关键类别零审计」：
 *   1) `requestId` 以前写的是 `'agent.observe'` 这种常量串或错误码本身 → 同一动作的多次调用
 *      在审计里无法区分。现在约定「每次调用一个真实 id，可带 `#说明` 后缀」；
 *   2) 技能/插件/分享包导入与 `ai:config:set` **零审计** → 现在都必须留痕；
 *   3) `audit:query` 的 filter 以前是 any 直通 SQL → 现在 strict schema。
 *
 * audit-logger 只依赖 db/database + crypto，所以这里 mock 掉数据库句柄，用 node:sqlite
 * 建真实的 audit_logs 表（与 task-update.test.ts 同一套做法；Node < 22.5 时跳过真库部分）。
 */

type SqliteStatement = {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}
type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}
type SqliteCtor = new (path: string) => SqliteDb

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch {
    return null
  }
}

const DatabaseSyncCtor = loadSqlite()
const realIt = DatabaseSyncCtor ? it : it.skip

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../apps/desktop/src/main/db/database', () => ({ getDatabase: () => holder.db }))

import { writeAudit, queryAudit, auditRequestId } from '../../apps/desktop/src/main/services/audit-logger'

/** audit_logs 与 migrations.ts 列一致；外键不建，改为断言"店铺不存在则写 NULL"的行为。 */
function createSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, store_id TEXT, action TEXT NOT NULL,
      result TEXT NOT NULL, request_id TEXT, created_at INTEGER NOT NULL
    );
  `)
}

function freshDb(): SqliteDb {
  const db = new DatabaseSyncCtor!(':memory:')
  createSchema(db)
  holder.db = db
  return db
}

beforeEach(() => {
  if (DatabaseSyncCtor) freshDb()
})

describe('auditRequestId（调用 id 的写法约定）', () => {
  it('无说明时就是原 id；空 id 也要兜底成随机串而不是空字符串', () => {
    expect(auditRequestId('abc-123')).toBe('abc-123')
    const fallback = auditRequestId('   ')
    expect(fallback.length).toBeGreaterThan(8)
    expect(fallback).not.toBe('')
  })

  it('带说明时用 # 分隔，并截断到 120 字符（列是 TEXT，但要防超长）', () => {
    expect(auditRequestId('abc', 'AI_BAD_INPUT')).toBe('abc#AI_BAD_INPUT')
    expect(auditRequestId('abc', 'x'.repeat(200))).toBe(`abc#${'x'.repeat(120)}`)
    expect(auditRequestId('abc', '   ')).toBe('abc')
  })
})

describe('queryAudit 的 requestId 过滤', () => {
  realIt('按调用 id 精确匹配成功记录、按前缀命中带 #说明 的失败记录', () => {
    const db = freshDb()
    db.prepare(`INSERT INTO stores(id) VALUES ('store-1')`).run()
    writeAudit('agent.observe', 'success', { storeId: 'store-1', requestId: auditRequestId('rid-a') })
    writeAudit('agent.observe', 'failure', { storeId: 'store-1', requestId: auditRequestId('rid-b', 'AGENT_INTERNAL_ERROR') })
    writeAudit('agent.observe', 'success', { storeId: 'store-1', requestId: auditRequestId('rid-b-other') })

    const exact = queryAudit({ requestId: 'rid-a' })
    expect(exact).toHaveLength(1)
    expect(exact[0].result).toBe('success')
    expect(exact[0].requestId).toBe('rid-a')

    // 前缀匹配只命中 rid-b 自己的失败记录，不能把 rid-b-other 也算进来
    const prefixed = queryAudit({ requestId: 'rid-b' })
    expect(prefixed).toHaveLength(1)
    expect(prefixed[0].result).toBe('failure')
    expect(prefixed[0].requestId).toBe('rid-b#AGENT_INTERNAL_ERROR')

    expect(queryAudit({ requestId: 'rid-nope' })).toHaveLength(0)
  })

  realIt('requestId 里的 % 与 _ 当字面量处理（不被当成 SQL 通配符）', () => {
    freshDb()
    writeAudit('ai.test', 'success', { requestId: auditRequestId('rid_%_x') })
    writeAudit('ai.test', 'success', { requestId: auditRequestId('ridZZx') })
    expect(queryAudit({ requestId: 'rid_%_x' }).map(r => r.requestId)).toEqual(['rid_%_x'])
  })

  realIt('action / storeId / 时间窗过滤仍然可用，limit 收敛到 1..1000', () => {
    const db = freshDb()
    db.prepare(`INSERT INTO stores(id) VALUES ('store-1')`).run()
    writeAudit('store.create', 'success', { storeId: 'store-1' })
    writeAudit('store.archive', 'success', { storeId: 'store-1' })
    expect(queryAudit({ action: 'store.create' })).toHaveLength(1)
    expect(queryAudit({ storeId: 'store-1' })).toHaveLength(2)
    expect(queryAudit({ from: Date.now() + 60_000 })).toHaveLength(0)
    expect(queryAudit({ limit: 0 })).toHaveLength(1) // 下限收敛到 1，不是"回全部"
    expect(queryAudit({ limit: 1000 })).toHaveLength(2)
  })

  realIt('店铺已不存在时写 NULL 的 store_id，而不是丢掉整条审计', () => {
    freshDb()
    writeAudit('store.deletePermanent', 'success', { storeId: 'store-gone' })
    const rows = queryAudit({ action: 'store.deletePermanent' })
    expect(rows).toHaveLength(1)
    expect(rows[0].storeId).toBeNull()
  })

  realIt('审计写入失败不抛异常（不能阻断主操作）', () => {
    holder.db = { prepare: () => { throw new Error('disk full') } }
    expect(() => writeAudit('store.purge', 'success')).not.toThrow()
  })
})

describe('audit:query 的 filter 必须过 strict schema', () => {
  it('接受合法过滤条件', () => {
    const parsed = auditQueryFilterSchema.parse({ storeId: 's', action: 'agent.observe', requestId: 'r', from: 1, to: 2, limit: 50 })
    expect(parsed.requestId).toBe('r')
  })

  it('拒绝多余键（以前是 any 直通，多传的键被静默忽略）', () => {
    expect(auditQueryFilterSchema.safeParse({ action: 'x', evil: 1 }).success).toBe(false)
  })

  it('limit 必须是数字且在范围内，时间戳不能是字符串/负数', () => {
    expect(auditQueryFilterSchema.safeParse({ limit: 'abc' }).success).toBe(false)
    expect(auditQueryFilterSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(auditQueryFilterSchema.safeParse({ limit: 5000 }).success).toBe(false)
    expect(auditQueryFilterSchema.safeParse({ from: 'now' }).success).toBe(false)
    expect(auditQueryFilterSchema.safeParse({ from: -1 }).success).toBe(false)
  })

  it('空对象是合法查询（面板不传 filter 时按默认 100 条返回）', () => {
    expect(auditQueryFilterSchema.parse({})).toEqual({})
  })
})

describe('关键类别零审计的回归守卫（源码级）', () => {
  const main = new URL('../../apps/desktop/src/main/', import.meta.url)
  const source = (rel: string) => readFileSync(new URL(rel, main), 'utf8')

  it('技能/插件/分享包的增删改都必须写审计', () => {
    const service = source('services/agent-service.ts')
    for (const action of [
      'agent.skill.create', 'agent.skill.update', 'agent.skill.delete', 'agent.skill.run',
      'agent.plugin.create', 'agent.plugin.update', 'agent.plugin.delete',
      'agent.pack.import', 'agent.pack.export'
    ]) {
      expect(service, action).toContain(`writeAudit('${action}'`)
    }
    // 对话里删技能/改技能必须复用带审计的那两个函数（不能再直接 DELETE）
    expect(service).toMatch(/deleteAgentSkill\(step\.action\.skillId, 'ai'\)/)
    expect(service).toMatch(/updateAgentSkill\(\{[\s\S]{0,200}?\}, 'ai'\)/)
  })

  it('ai:config:set 必须写 ai.config 审计（成功与失败都要）', () => {
    const ai = source('ipc/ai-handlers.ts')
    expect(ai).toContain("writeAudit('ai.config', 'success'")
    expect(ai).toContain("writeAudit('ai.config', 'failure'")
  })

  it('业务 IPC 里不得再出现常量串 requestId（P2 的原问题）', () => {
    const files = [
      'ipc/agent-handlers.ts', 'ipc/ai-handlers.ts', 'ipc/session-security-handlers.ts',
      'ipc/profile-misc-handlers.ts', 'ipc/store-handlers.ts', 'ipc/task-handlers.ts',
      'ipc/browser-handlers.ts', 'ipc/bookmark-download-handlers.ts', 'ipc/proxy-backup-handlers.ts',
      'ipc/update-handlers.ts'
    ]
    for (const file of files) {
      const text = source(file)
      // writeAudit 的 requestId 只能来自变量或 auditRequestId(...)，不能再是字面量
      expect(text, file).not.toMatch(/writeAudit\([^)]*requestId: '/)
      expect(text, file).not.toMatch(/writeAudit\([^)]*requestId: [A-Za-z_$][\w$]*\.code/)
    }
  })
})
