import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrations } from '../../apps/desktop/src/main/db/migrations'
import { migrateLegacyAgentMemoryFiles, rewriteAgentMemoryFrontMatter } from '../../apps/desktop/src/main/services/agent-memory-agent-migration'

type Statement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }
type SqliteDb = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
type SqliteCtor = new (path: string) => SqliteDb

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch { return null }
}

const DatabaseSyncCtor = loadSqlite()
const realDbIt = DatabaseSyncCtor ? it : it.skip
const ROOT = 'root-ceo'
const LEGACY = 'agent-legacy'

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeDb(): SqliteDb {
  const db = new DatabaseSyncCtor!(':memory:')
  for (const migration of migrations) migration.up(db as never)
  db.prepare(`INSERT INTO agents(
    id,parent_id,name,role,description,status,prompt_version,model_profile_id,
    tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,
    max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ROOT, null, '主 Agent', 'ceo', '', 'active', 'ceo-v1', null, '{}', '{}', '{}', '[]', 1, null, 120000, null, 1, 1
  )
  db.prepare(`INSERT INTO agents(
    id,parent_id,name,role,description,status,prompt_version,model_profile_id,
    tool_policy_json,store_scope_json,memory_scope_json,success_criteria_json,
    max_concurrency,daily_budget_json,timeout_ms,created_by_agent_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    LEGACY, ROOT, '旧 Agent', 'operator', '', 'active', 'v1', null, '{}', '{}', '{}', '[]', 1, null, 120000, ROOT, 1, 1
  )
  return db
}

function addRecord(db: SqliteDb, id: string, path: string, content: string, scope: 'store' | 'private'): void {
  const now = Date.now()
  db.prepare(`INSERT INTO agent_memory_records(
    id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,
    sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,
    last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, LEGACY, null, scope, scope === 'private' ? 'semantic' : 'procedural', id,
    path, hash(content), 0.8, null, 'approved', scope === 'private' ? 'private' : 'internal', null,
    now, now, 'manual', null, 0, 0, 0, null, null, null, null, 0
  )
}

function withTransaction(db: SqliteDb): (fn: () => void) => () => void {
  return fn => () => {
    db.exec('BEGIN')
    try { fn(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  }
}

describe('single-agent memory file migration', () => {
  const tempRoots: string[] = []
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  realDbIt('迁移公开/私有文件并同步 front matter、manifest、SQLite，重复启动幂等', () => {
    const root = mkdtempSync(join(process.env.TEMP || process.env.TMP || '.', 'shopilot-memory-migration-'))
    tempRoots.push(root)
    const legacyDir = join(root, 'agents', LEGACY)
    const rootDir = join(root, 'agents', ROOT)
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(rootDir, { recursive: true })

    const publicId = `mem_${randomUUID()}`
    const privateId = `mem_${randomUUID()}`
    const publicBody = `---\nid: ${publicId}\nformat: shopilot-agent-memory\nversion: 1\nagentId: ${LEGACY}\nstoreId: \nscope: store\ntype: procedural\nstatus: approved\norigin: manual\nsourceJobId: \nsourceRef: \n---\n店铺规则正文\n`
    const privateBody = `---\nid: ${privateId}\nformat: shopilot-agent-memory\nversion: 1\nagentId: ${LEGACY}\nstoreId: \nscope: private\ntype: semantic\nstatus: approved\norigin: manual\nsourceJobId: \nsourceRef: \n---\n私有规则正文\n`
    const publicPath = join(legacyDir, `${publicId}.md`)
    const privatePath = join(legacyDir, `${privateId}.mem.enc`)
    // The private fixture is an envelope-shaped value. The production caller
    // supplies safeStorage decode/re-encode; this test exercises the same
    // path/hash/manifest contract without requiring Electron's OS key store.
    const privateStored = JSON.stringify({ format: 'test-private-envelope', body: privateBody })
    writeFileSync(publicPath, publicBody)
    writeFileSync(privatePath, privateStored)
    const untouchedPath = join(rootDir, 'mem_user.md')
    writeFileSync(untouchedPath, '---\nagentId: user\n---\n用户内容\n')
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      format: 'shopilot-agent-memory', version: 1, entries: [
        { id: publicId, path: `agents/${LEGACY}/${publicId}.md`, sha256: hash(publicBody), bytes: Buffer.byteLength(publicBody) },
        { id: privateId, path: `agents/${LEGACY}/${privateId}.mem.enc`, sha256: hash(privateStored), bytes: Buffer.byteLength(privateStored) }
      ]
    }))

    const db2 = makeDb()
    addRecord(db2, publicId, publicPath, publicBody, 'store')
    addRecord(db2, privateId, privatePath, privateStored, 'private')
    const result2 = migrateLegacyAgentMemoryFiles({
      root,
      rootAgentId: ROOT,
      db: Object.assign(db2, { transaction: withTransaction(db2) }) as any,
      rewriteStored: (stored, oldPath) => oldPath.endsWith('.mem.enc')
        ? { stored: JSON.stringify({ ...JSON.parse(stored), body: rewriteAgentMemoryFrontMatter(JSON.parse(stored).body, ROOT) }) }
        : { stored: rewriteAgentMemoryFrontMatter(stored, ROOT) },
      equivalentStored: (existing, targetPath, desired) => targetPath.endsWith('.mem.enc')
        ? JSON.parse(existing).body === JSON.parse(desired).body
        : existing === desired
    })
    expect(result2.scanned).toBe(2)
    expect(result2.migrated).toBe(2)
    expect(result2.removed).toBe(2)
    expect(existsSync(publicPath)).toBe(false)
    expect(existsSync(privatePath)).toBe(false)
    const migratedPublicPath = join(rootDir, `${publicId}.md`)
    const migratedPrivatePath = join(rootDir, `${privateId}.mem.enc`)
    expect(readFileSync(migratedPublicPath, 'utf8')).toContain(`agentId: ${ROOT}`)
    expect(JSON.parse(readFileSync(migratedPrivatePath, 'utf8')).body).toContain(`agentId: ${ROOT}`)
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: publicId, path: `agents/${ROOT}/${publicId}.md`, sha256: hash(readFileSync(migratedPublicPath, 'utf8')) }),
      expect.objectContaining({ id: privateId, path: `agents/${ROOT}/${privateId}.mem.enc`, sha256: hash(readFileSync(migratedPrivatePath, 'utf8')) })
    ]))
    expect((db2.prepare('SELECT agent_id,file_path,content_hash FROM agent_memory_records WHERE id=?').get(publicId) as any)).toEqual({
      agent_id: ROOT, file_path: migratedPublicPath, content_hash: hash(readFileSync(migratedPublicPath, 'utf8'))
    })
    expect((db2.prepare('SELECT agent_id,file_path,content_hash FROM agent_memory_records WHERE id=?').get(privateId) as any)).toEqual({
      agent_id: ROOT, file_path: migratedPrivatePath, content_hash: hash(readFileSync(migratedPrivatePath, 'utf8'))
    })
    expect(readFileSync(untouchedPath, 'utf8')).toContain('agentId: user')

    const second = migrateLegacyAgentMemoryFiles({ root, rootAgentId: ROOT, db: Object.assign(db2, { transaction: withTransaction(db2) }) as any })
    expect(second.scanned).toBe(0)
    expect(second.migrated).toBe(0)
    expect(readFileSync(migratedPublicPath, 'utf8')).toContain(`agentId: ${ROOT}`)
    db2.close()
  })
})

