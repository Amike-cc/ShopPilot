import { ROOT_AGENT_ID } from '@shared/schemas/agent-domain'

/**
 * The database-only part of the single-agent upgrade.
 *
 * Keep this separate from Electron/runtime concerns so the upgrade can be
 * exercised against an old SQLite schema in a unit test.  The caller owns the
 * transaction; this function only rewrites foreign-key references and removes
 * historical Agent rows after every durable record points at root-ceo.
 */
export interface AgentSingletonMigrationDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

type JsonRecord = Record<string, unknown>

function parseRecord(value: unknown): JsonRecord {
  try {
    const parsed = JSON.parse(String(value ?? '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : {}
  } catch {
    return {}
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * Merge all legacy Agent-owned state into the singleton root-ceo identity.
 *
 * Existing Job payloads, evidence, memory records, usage and governance rows
 * remain in place.  Only their Agent ownership/reviewer references and the
 * mutable permission part of frozen Job snapshots are rewritten.  The
 * historical model Profiles themselves are retained for audit/recovery; their
 * child bindings are removed and the caller later installs the main Profile
 * binding for root-ceo.
 */
export function migrateLegacyAgentStateToRoot(
  db: AgentSingletonMigrationDb,
  rootId: string = ROOT_AGENT_ID
): void {
  const rootRow = db.prepare(
    'SELECT tool_policy_json,store_scope_json,memory_scope_json,max_concurrency,daily_budget_json FROM agents WHERE id=?'
  ).get(rootId) as Record<string, unknown> | undefined
  if (!rootRow) throw new Error(`Missing singleton Agent: ${rootId}`)

  // Capture exact historical identities before deleting their rows. `actor`
  // is intentionally free text: values such as `user` are valid audit actors
  // and must remain unchanged.
  const legacyAgentIds = (db.prepare('SELECT id FROM agents WHERE id<>?').all(rootId) as Array<{ id: string }>).map(row => String(row.id))

  const rootPermission = {
    assignedAgentId: rootId,
    actorId: rootId,
    toolPolicy: parseRecord(rootRow.tool_policy_json),
    storeScope: parseRecord(rootRow.store_scope_json),
    memoryScope: parseRecord(rootRow.memory_scope_json),
    maxConcurrency: Number(rootRow.max_concurrency || 1),
    dailyBudget: rootRow.daily_budget_json
      ? parseRecord(rootRow.daily_budget_json)
      : null
  }

  const historicalJobs = db.prepare('SELECT id,permission_snapshot_json,store_scope_snapshot_json,memory_scope_snapshot_json FROM agent_jobs').all() as Array<Record<string, unknown>>
  for (const job of historicalJobs) {
    const snapshot = parseRecord(job.permission_snapshot_json)
    const storeScope = parseRecord(job.store_scope_snapshot_json)
    const memoryScope = parseRecord(job.memory_scope_snapshot_json)
    // The store scope is duplicated in permission_snapshot_json for the
    // generic permission check and in its own frozen column for browser and
    // memory routing.  Keep both representations aligned with root-ceo after
    // ownership migration; otherwise a legacy child scope could silently
    // survive in the dedicated snapshot and disagree with the rewritten
    // permission snapshot.
    db.prepare('UPDATE agent_jobs SET permission_snapshot_json=?,store_scope_snapshot_json=?,memory_scope_snapshot_json=? WHERE id=?').run(
      encode({ ...snapshot, ...rootPermission }),
      encode({ ...storeScope, ...rootPermission.storeScope }),
      encode({ ...memoryScope, agentIds: [rootId] }),
      job.id
    )
  }

  db.prepare('UPDATE agent_jobs SET created_by_agent_id=? WHERE created_by_agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_jobs SET assigned_agent_id=? WHERE assigned_agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_memory_records SET agent_id=? WHERE agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_memory_events SET agent_id=? WHERE agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_usage SET agent_id=? WHERE agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_job_results SET reviewer_agent_id=? WHERE reviewer_agent_id IS NOT NULL AND reviewer_agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_feedback SET reviewer_agent_id=? WHERE reviewer_agent_id IS NOT NULL AND reviewer_agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_skills SET created_by_agent_id=? WHERE created_by_agent_id IS NOT NULL AND created_by_agent_id<>?').run(rootId, rootId)
  db.prepare('UPDATE agent_plugins SET created_by_agent_id=? WHERE created_by_agent_id IS NOT NULL AND created_by_agent_id<>?').run(rootId, rootId)
  const rewriteEventActor = db.prepare('UPDATE agent_job_events SET actor=? WHERE actor=?')
  for (const legacyAgentId of legacyAgentIds) rewriteEventActor.run(rootId, legacyAgentId)
  // The singleton has no parent or creator Agent, even after a partial upgrade.
  db.prepare('UPDATE agents SET parent_id=NULL,created_by_agent_id=NULL WHERE id=?').run(rootId)
  db.prepare('DELETE FROM agent_model_bindings WHERE agent_id<>?').run(rootId)
  db.prepare('DELETE FROM agents WHERE id<>?').run(rootId)
}
