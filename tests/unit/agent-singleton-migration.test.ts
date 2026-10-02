import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrations } from '../../apps/desktop/src/main/db/migrations'
import { migrateLegacyAgentStateToRoot } from '../../apps/desktop/src/main/services/agent-singleton-migration'

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
const realDbIt = DatabaseSyncCtor ? it : it.skip

const ROOT = 'root-ceo'
const CHILD = 'agent_legacy_operator'
const NOW = 1_750_000_000_000

function makeDb(): SqliteDb {
  const db = new DatabaseSyncCtor!(':memory:')
  for (const migration of migrations) migration.up(db as never)
  db.prepare(`INSERT INTO agents(
    id,parent_id,name,role,description,status,prompt_version,model_profile_id,
    tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,
    max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ROOT, null, '主 Agent', 'ceo', '', 'active', 'ceo-v1', null,
    JSON.stringify({ tools: ['read_text'], canCreateAgent: false }),
    JSON.stringify({ storeIds: [], readOnly: false }),
    JSON.stringify({ agentIds: [ROOT], includeShared: true, write: true }),
    JSON.stringify(['完成']), 4, null, 120000, null, NOW, NOW
  )
  db.prepare(`INSERT INTO agents(
    id,parent_id,name,role,description,status,prompt_version,model_profile_id,
    tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,
    max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    CHILD, ROOT, '历史执行助手', 'operator', '', 'active', 'operator-v1', 'legacy-profile',
    JSON.stringify({ tools: ['click'] }),
    JSON.stringify({ storeIds: ['store-1'], readOnly: true }),
    JSON.stringify({ agentIds: [CHILD], includeShared: false, write: true }),
    JSON.stringify(['完成']), 1, JSON.stringify({ currency: 'USD', amount: 10 }), 120000, ROOT, NOW - 1000, NOW - 1000
  )
  db.prepare(`INSERT INTO agent_model_profiles(
    id,name,provider,endpoint,model,credential_ref,temperature,max_tokens,timeout_ms,
    fallback_profile_id,capabilities_json,concurrency_limit,daily_budget_json,pricing_json,
    enabled,health,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'legacy-profile', '历史模型', 'test', 'https://example.com/v1/chat/completions', 'legacy', null,
    0.7, 100, 1000, null, '{}', 1, null, null, 1, 'unknown', NOW, NOW
  )
  db.prepare('INSERT INTO agent_model_bindings(agent_id,model_profile_id,updated_at) VALUES (?,?,?)').run(CHILD, 'legacy-profile', NOW)
  return db
}

function seedOwnedRows(db: SqliteDb): void {
  // Exercise a partially upgraded root row that still points at a child.
  db.prepare('UPDATE agents SET parent_id=?,created_by_agent_id=? WHERE id=?').run(CHILD, CHILD, ROOT)
  db.prepare(`INSERT INTO agent_jobs(
    id,parent_job_id,created_by_agent_id,assigned_agent_id,browser_task_id,browser_run_id,store_id,
    goal,input_summary_json,permission_snapshot_json,store_scope_snapshot_json,memory_scope_snapshot_json,
    model_snapshot_json,payload_hash,status,priority,requires_confirmation,confirmation_id,
    confirmation_approved,confirmation_expires_at,lease_owner,lease_expires_at,idempotency_key,
    attempt_count,version,dependencies_json,risk,side_effect_started,created_at,started_at,completed_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'job-legacy', null, CHILD, CHILD, null, null, null, '历史 Job', '{}',
    JSON.stringify({ actorId: CHILD, assignedAgentId: CHILD, toolPolicy: { tools: ['click'] }, storeScope: { storeIds: ['store-1'] }, memoryScope: { agentIds: [CHILD] }, maxConcurrency: 1, dailyBudget: null }),
    JSON.stringify({ storeIds: ['store-1'], readOnly: true }), JSON.stringify({ agentIds: [CHILD], write: true }),
    JSON.stringify({ id: 'legacy-profile' }), 'hash', 'succeeded', 50, 0, null, 1, null, null, null, 'legacy-key', 1, 0, '[]', 'read', 0, NOW, NOW, NOW, NOW
  )
  db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run('event-legacy', 'job-legacy', null, 'succeeded', CHILD, '完成', null, NOW)
  db.prepare('INSERT INTO agent_job_events(id,job_id,from_status,to_status,actor,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run('event-user', 'job-legacy', null, 'succeeded', 'user', '用户确认', null, NOW)
  db.prepare(`INSERT INTO agent_memory_records(
    id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,
    sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,
    last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'memory-legacy', CHILD, null, 'private', 'semantic', '历史记忆', 'agents/legacy/memory.md', 'hash-memory', 0.8,
    'job-legacy', 'approved', 'internal', null, NOW, NOW, 'job', 'legacy-ref', 1, 1, 0, NOW, null, null, 'dedupe', 0
  )
  db.prepare('INSERT INTO agent_memory_events(id,memory_id,agent_id,job_id,event_type,created_at) VALUES (?,?,?,?,?,?)').run('memory-event-legacy', 'memory-legacy', CHILD, 'job-legacy', 'hit', NOW)
  db.prepare('INSERT INTO agent_job_results(id,job_id,task_run_id,kind,summary,evidence_json,approved,reviewer_agent_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('result-legacy', 'job-legacy', null, 'summary', '历史结果', '{}', 1, CHILD, NOW)
  db.prepare('INSERT INTO agent_feedback(id,job_id,memory_id,reviewer_agent_id,rating,correction,created_at) VALUES (?,?,?,?,?,?,?)').run('feedback-legacy', 'job-legacy', 'memory-legacy', CHILD, 5, '保留', NOW)
  db.prepare('INSERT INTO agent_usage(id,agent_id,profile_id,job_id,input_tokens,output_tokens,cost_json,estimated,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('usage-legacy', CHILD, 'legacy-profile', 'job-legacy', 10, 20, null, 1, 'succeeded', null, NOW)
  db.prepare('INSERT INTO agent_skills(id,name,description,intent,steps_json,status,source,plugin_id,created_by_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('skill-legacy', '历史技能', '', '', '[]', 'enabled', 'user', null, CHILD, NOW, NOW)
  db.prepare('INSERT INTO agent_plugins(id,name,description,skill_ids_json,source,created_by_agent_id,created_at) VALUES (?,?,?,?,?,?,?)').run('plugin-legacy', '历史插件', '', '[]', 'user', CHILD, NOW)
}

describe('single-agent startup migration', () => {
  realDbIt('归并历史 Agent 的 Job、权限、记忆、用量、审核、技能和插件，并可重复执行', () => {
    const db = makeDb()
    seedOwnedRows(db)

    db.exec('BEGIN')
    migrateLegacyAgentStateToRoot(db)
    db.exec('COMMIT')

    expect((db.prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map(row => row.id)).toEqual([ROOT])
    expect((db.prepare('SELECT parent_id,created_by_agent_id FROM agents WHERE id=?').get(ROOT) as any)).toEqual({ parent_id: null, created_by_agent_id: null })
    expect((db.prepare('SELECT agent_id FROM agent_model_bindings').all() as Array<{ agent_id: string }>).map(row => row.agent_id)).toEqual([])
    expect((db.prepare('SELECT created_by_agent_id,assigned_agent_id FROM agent_jobs WHERE id=?').get('job-legacy') as any)).toEqual({ created_by_agent_id: ROOT, assigned_agent_id: ROOT })
    expect((db.prepare('SELECT agent_id FROM agent_memory_records WHERE id=?').get('memory-legacy') as any).agent_id).toBe(ROOT)
    expect((db.prepare('SELECT agent_id FROM agent_memory_events WHERE id=?').get('memory-event-legacy') as any).agent_id).toBe(ROOT)
    expect((db.prepare('SELECT agent_id FROM agent_usage WHERE id=?').get('usage-legacy') as any).agent_id).toBe(ROOT)
    expect((db.prepare('SELECT reviewer_agent_id FROM agent_job_results WHERE id=?').get('result-legacy') as any).reviewer_agent_id).toBe(ROOT)
    expect((db.prepare('SELECT reviewer_agent_id FROM agent_feedback WHERE id=?').get('feedback-legacy') as any).reviewer_agent_id).toBe(ROOT)
    expect((db.prepare('SELECT created_by_agent_id FROM agent_skills WHERE id=?').get('skill-legacy') as any).created_by_agent_id).toBe(ROOT)
    expect((db.prepare('SELECT created_by_agent_id FROM agent_plugins WHERE id=?').get('plugin-legacy') as any).created_by_agent_id).toBe(ROOT)
    expect((db.prepare('SELECT actor FROM agent_job_events WHERE id=?').get('event-legacy') as any).actor).toBe(ROOT)
    expect((db.prepare('SELECT actor FROM agent_job_events WHERE id=?').get('event-user') as any).actor).toBe('user')

    const permission = JSON.parse(String((db.prepare('SELECT permission_snapshot_json FROM agent_jobs WHERE id=?').get('job-legacy') as any).permission_snapshot_json))
    expect(permission.actorId).toBe(ROOT)
    expect(permission.assignedAgentId).toBe(ROOT)
    expect(permission.toolPolicy).toEqual({ tools: ['read_text'], canCreateAgent: false })
    expect(permission.storeScope).toEqual({ storeIds: [], readOnly: false })
    expect(permission.memoryScope).toEqual({ agentIds: [ROOT], includeShared: true, write: true })
    const storeScope = JSON.parse(String((db.prepare('SELECT store_scope_snapshot_json FROM agent_jobs WHERE id=?').get('job-legacy') as any).store_scope_snapshot_json))
    expect(storeScope).toEqual({ storeIds: [], readOnly: false })
    const memoryScope = JSON.parse(String((db.prepare('SELECT memory_scope_snapshot_json FROM agent_jobs WHERE id=?').get('job-legacy') as any).memory_scope_snapshot_json))
    expect(memoryScope).toEqual({ agentIds: [ROOT], write: true })

    // A second startup must not duplicate rows or resurrect deleted children.
    db.exec('BEGIN')
    migrateLegacyAgentStateToRoot(db)
    db.exec('COMMIT')
    expect((db.prepare('SELECT COUNT(*) AS count FROM agents').get() as any).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM agent_jobs').get() as any).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM agent_memory_records').get() as any).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM agent_model_bindings').get() as any).count).toBe(0)

    // Historical model Profiles are retained for audit/recovery; only child bindings disappear.
    expect((db.prepare('SELECT id FROM agent_model_profiles WHERE id=?').get('legacy-profile') as any).id).toBe('legacy-profile')
    db.close()
  })
})
