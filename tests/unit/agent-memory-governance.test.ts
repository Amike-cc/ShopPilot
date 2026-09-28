import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrations } from '../../apps/desktop/src/main/db/migrations'
import { consolidateDuplicateMemories, deriveMemoryDedupeKey, maintainMemoryRecords, type MemoryGovernanceDb } from '../../apps/desktop/src/main/services/agent-memory-governance'

// 记忆治理（尤其是近重复合并）是新增路径：真机 CDP 只能跑到「无重复组」就返回，
// 合并分支从未被执行过。这里用 node:sqlite 跑真实迁移建表，直接覆盖合并/不合并的边界。
type SqliteDb = MemoryGovernanceDb & { exec(sql: string): void; close(): void }
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
const realDbIt = DatabaseSyncCtor ? it : it.skip

const NOW = 1_700_000_000_000

function makeDb(): SqliteDb {
  const db = new DatabaseSyncCtor!(':memory:')
  // 全新库走完整迁移链，保证测的是真实 schema（含 v11 的 dedupe_key / repeat_count）
  for (const migration of migrations) migration.up(db as never)
  db.prepare(`INSERT INTO agents(id,parent_id,name,role,description,status,prompt_version,model_profile_id,tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'root-ceo', null, 'CEO', 'ceo', '', 'active', 'ceo-v1', null, '{}', '{}', '{}', '[]', 1, null, 120000, null, NOW, NOW
  )
  return db
}

let sequence = 0
function insertMemory(db: SqliteDb, overrides: Record<string, unknown> = {}): string {
  const id = String(overrides.id || `mem_${++sequence}`)
  const row = {
    id,
    agentId: 'root-ceo', storeId: null, scope: 'shared', type: 'semantic', title: `记忆 ${id}`,
    filePath: `agents/root-ceo/${id}.md`,
    contentHash: `hash_${id}`,
    confidence: 0.5,
    status: 'pending-review',
    sensitivity: 'internal',
    expiresAt: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    origin: 'conversation',
    sourceRef: null,
    accessCount: 0, adoptCount: 0, rejectCount: 0, repeatCount: 0,
    lastHitAt: null, lastFeedbackAt: null, archivedAt: null,
    dedupeKey: null,
    ...overrides
  }
  db.prepare(`INSERT INTO agent_memory_records(id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.agentId, row.storeId, row.scope, row.type, row.title, row.filePath, row.contentHash, row.confidence, null,
    row.status, row.sensitivity, row.expiresAt, row.createdAt, row.updatedAt, row.origin, row.sourceRef,
    row.accessCount, row.adoptCount, row.rejectCount, row.lastHitAt, row.lastFeedbackAt, row.archivedAt, row.dedupeKey, row.repeatCount
  )
  return id
}

function readMemory(db: SqliteDb, id: string): any {
  return db.prepare('SELECT * FROM agent_memory_records WHERE id=?').get(id)
}

describe('记忆指纹', () => {
  it('同一规则的写法差异得到同一把钥匙，过长正文不参与去重', () => {
    expect(deriveMemoryDedupeKey('库存低于 10 件时，先看证据。')).toBe(deriveMemoryDedupeKey('库存低于10件时,先看证据'))
    expect(deriveMemoryDedupeKey('库存低于 10 件时先看证据')).not.toBe(deriveMemoryDedupeKey('库存低于 5 件时先看证据'))
    expect(deriveMemoryDedupeKey('x'.repeat(2001))).toBeNull()
    expect(deriveMemoryDedupeKey('   ')).toBeNull()
  })
})

describe('近重复合并（consolidated）', () => {
  realDbIt('同一把钥匙只留一条：approved 优先，计数折算，其余归档可追溯', () => {
    const db = makeDb()
    const keeper = insertMemory(db, { status: 'approved', confidence: 0.6, dedupeKey: 'k', adoptCount: 1, accessCount: 2, repeatCount: 0, updatedAt: NOW - 1000 })
    const other = insertMemory(db, { status: 'pending-review', confidence: 0.9, dedupeKey: 'k', rejectCount: 2, accessCount: 3, repeatCount: 1, updatedAt: NOW - 500, lastHitAt: NOW - 100 })
    const unrelated = insertMemory(db, { status: 'approved', dedupeKey: 'other' })

    expect(consolidateDuplicateMemories(db, NOW)).toBe(1)

    const merged = readMemory(db, keeper)
    expect(merged.origin).toBe('consolidated')
    expect(merged.confidence).toBeCloseTo(0.9)      // 取组内最高
    expect(merged.adopt_count).toBe(1)              // 计数折算
    expect(merged.reject_count).toBe(2)
    expect(merged.access_count).toBe(5)
    expect(merged.repeat_count).toBe(2)             // 自身 0 + 被合并 1 条 + 重复观察 1 次
    expect(merged.last_hit_at).toBe(NOW - 100)
    expect(merged.status).toBe('approved')          // 状态不被改动

    const archived = readMemory(db, other)
    expect(archived.status).toBe('stale')
    expect(archived.archived_at).toBe(NOW)          // 保留可追溯，不再进检索

    const untouched = readMemory(db, unrelated)
    expect(untouched.origin).toBe('conversation')
    expect(untouched.archived_at).toBeNull()
    db.close()
  })

  realDbIt('待审核组内合并后仍然是待审核（取置信度最高者），绝不自动批准', () => {
    const db = makeDb()
    const lower = insertMemory(db, { status: 'pending-review', confidence: 0.4, dedupeKey: 'k2', updatedAt: NOW - 100 })
    const higher = insertMemory(db, { status: 'pending-review', confidence: 0.8, dedupeKey: 'k2', updatedAt: NOW - 500 })
    expect(consolidateDuplicateMemories(db, NOW)).toBe(1)
    // 同状态时按 confidence DESC 选幸存者，而不是按插入顺序
    expect(readMemory(db, higher).status).toBe('pending-review')
    expect(readMemory(db, higher).origin).toBe('consolidated')
    expect(readMemory(db, lower).status).toBe('stale')
    expect(readMemory(db, lower).archived_at).toBe(NOW)
    db.close()
  })

  realDbIt('隔离/已归档/跨店铺/无指纹的记录都不参与合并', () => {
    const db = makeDb()
    insertMemory(db, { id: 'q1', status: 'quarantined', dedupeKey: 'kq' })
    insertMemory(db, { id: 'q2', status: 'approved', dedupeKey: 'kq' })
    insertMemory(db, { id: 'a1', status: 'approved', dedupeKey: 'ka', archivedAt: NOW - 1 })
    insertMemory(db, { id: 'a2', status: 'approved', dedupeKey: 'ka' })
    insertMemory(db, { id: 's1', status: 'approved', dedupeKey: 'ks', storeId: null })
    insertMemory(db, { id: 'n1', status: 'approved', dedupeKey: null })
    insertMemory(db, { id: 'n2', status: 'approved', dedupeKey: null })

    // s1/s2 只有一条同店铺，n1/n2 没有指纹，q 组被隔离，a 组已归档 → 无可合并
    expect(consolidateDuplicateMemories(db, NOW)).toBe(0)
    expect(readMemory(db, 'q1').status).toBe('quarantined')
    expect(readMemory(db, 'q2').origin).toBe('conversation')
    expect(readMemory(db, 'a2').archived_at).toBeNull()
    db.close()
  })

  realDbIt('不同范围/不同类型即便正文相同也不合并（避免跨语义误并）', () => {
    const db = makeDb()
    insertMemory(db, { id: 'sc1', status: 'approved', dedupeKey: 'ksc', scope: 'shared' })
    insertMemory(db, { id: 'sc2', status: 'approved', dedupeKey: 'ksc', scope: 'private' })
    insertMemory(db, { id: 't1', status: 'approved', dedupeKey: 'kt', type: 'semantic' })
    insertMemory(db, { id: 't2', status: 'approved', dedupeKey: 'kt', type: 'procedural' })
    expect(consolidateDuplicateMemories(db, NOW)).toBe(0)
    db.close()
  })

  realDbIt('合并是可重入的：再跑一次不会产生新的归档', () => {
    const db = makeDb()
    insertMemory(db, { status: 'approved', dedupeKey: 'kr' })
    insertMemory(db, { status: 'approved', dedupeKey: 'kr' })
    expect(consolidateDuplicateMemories(db, NOW)).toBe(1)
    expect(consolidateDuplicateMemories(db, NOW + 1000)).toBe(0)
    db.close()
  })
})

describe('记忆生命周期治理', () => {
  realDbIt('过期 → stale，反复被拒且低置信 → stale，超过保留期的 stale → 归档', () => {
    const db = makeDb()
    const expired = insertMemory(db, { id: 'exp', status: 'approved', expiresAt: NOW - 1 })
    const lowConfidence = insertMemory(db, { id: 'low', status: 'approved', rejectCount: 3, confidence: 0.2 })
    const oldStale = insertMemory(db, { id: 'old', status: 'stale', updatedAt: NOW - 400 * 86400000 })
    const fresh = insertMemory(db, { id: 'fresh', status: 'approved', updatedAt: NOW - 1000 })
    const keptStale = insertMemory(db, { id: 'kept', status: 'stale', updatedAt: NOW - 1000 })

    const result = maintainMemoryRecords(db, NOW, 180)

    expect(result.expired).toBe(1)
    expect(result.lowConfidence).toBe(1)
    expect(result.archived).toBe(1)
    expect(result.consolidated).toBe(0)
    expect(readMemory(db, expired).status).toBe('stale')
    expect(readMemory(db, lowConfidence).status).toBe('stale')
    expect(readMemory(db, oldStale).archived_at).toBe(NOW)
    expect(readMemory(db, fresh).status).toBe('approved')
    expect(readMemory(db, fresh).archived_at).toBeNull()
    // 未超过保留期的 stale 只归档，不因为变成 stale 就立刻消失
    expect(readMemory(db, keptStale).archived_at).toBeNull()
    db.close()
  })

  realDbIt('一次治理同时返回合并计数与归档计数', () => {
    const db = makeDb()
    insertMemory(db, { status: 'approved', dedupeKey: 'km' })
    insertMemory(db, { status: 'approved', dedupeKey: 'km' })
    insertMemory(db, { id: 'dead', status: 'stale', updatedAt: NOW - 400 * 86400000 })
    const result = maintainMemoryRecords(db, NOW, 180)
    expect(result.consolidated).toBe(1)
    expect(result.archived).toBe(1)
    db.close()
  })
})
