import { createHash } from 'node:crypto'
import { memoryDedupeText } from '@shared/agent-memory-rules'

/**
 * 记忆治理（过期 / 低置信度 / 近重复收敛 / 保留期归档）的**唯一**实现。
 *
 * 单独成文件的原因和 shared/agent-memory-rules 一样：这里的逻辑原本内联在
 * agent-memory.ts 里，而 agent-memory.ts 顶层 `import electron`，导致这段 SQL
 * 完全无法单测（只有真机 CDP 能跑到）。现在它只依赖一个最小的 db 句柄结构，
 * 既可以被 better-sqlite3（Main）驱动，也可以在单测里用 node:sqlite 驱动。
 *
 * 安全语义：这里全是**确定性治理**，不产生新内容、不改权限、不自动批准；
 * 隔离记忆永远不参与合并与去重。
 */

type SqlStatement = {
  all: (...params: any[]) => any[]
  get: (...params: any[]) => any
  run: (...params: any[]) => { changes: number }
}

export interface MemoryGovernanceDb {
  prepare(sql: string): SqlStatement
}

/**
 * 规范正文指纹：先做 canonical（大小写/空白/标点归一），再哈希。
 * 正文过长时 canonical 为 null → 该记忆不参与去重，避免误合并长任务记录。
 */
export function deriveMemoryDedupeKey(content: unknown): string | null {
  const canonical = memoryDedupeText(content)
  if (!canonical) return null
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 同一把钥匙下一条记忆都没合并时不做任何写入。 */
const DUPLICATE_GROUP_LIMIT = 50

/**
 * 近重复收敛：同一个 Agent/店铺/范围/类型下规范正文相同的记忆只保留一条。
 *
 * 幸存者优先 approved，其次 pending-review；被合并的条目保留在库里
 * （status=stale + archived_at）以便追溯，只是不再进入检索与模型提示词。
 * 幸存者标记为 origin='consolidated'（AGENT_MEMORY_ORIGINS 里这条来源的真实含义），
 * 并把被合并条目的命中/采纳/拒绝/重复计数折算过来。
 *
 * 这里刻意不用 db.transaction：逐条 UPDATE 各自原子，部分失败只会留下
 * 「幸存者已折算、个别重复项未归档」这种可重入的中间态，下一次治理会补上。
 */
export function consolidateDuplicateMemories(db: MemoryGovernanceDb, at: number): number {
  let groups: any[] = []
  try {
    groups = db.prepare(`SELECT dedupe_key, agent_id, store_id, scope, type, COUNT(*) AS c
      FROM agent_memory_records
      WHERE dedupe_key IS NOT NULL AND archived_at IS NULL AND status<>'quarantined'
      GROUP BY dedupe_key, agent_id, store_id, scope, type
      HAVING c>1 LIMIT ${DUPLICATE_GROUP_LIMIT}`).all()
  } catch {
    return 0 // v11 之前的库没有 dedupe_key 列
  }
  let merged = 0
  for (const group of groups) {
    let rows: any[] = []
    try {
      rows = db.prepare(`SELECT id,status,confidence,access_count,adopt_count,reject_count,repeat_count,last_hit_at FROM agent_memory_records
        WHERE dedupe_key=? AND agent_id=? AND store_id IS ? AND scope=? AND type=? AND archived_at IS NULL AND status<>'quarantined'
        ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending-review' THEN 1 ELSE 2 END, confidence DESC, updated_at ASC`)
        .all(group.dedupe_key, group.agent_id, group.store_id, group.scope, group.type)
    } catch { continue }
    if (rows.length < 2) continue
    const survivor = rows[0]
    const duplicates = rows.slice(1)
    const clamp = (value: unknown): number => Math.max(0, Math.min(1, Number(value || 0)))
    const confidence = Math.min(1, Math.max(...rows.map(row => clamp(row.confidence))))
    const sum = (key: string): number => rows.reduce((total, row) => total + Number(row[key] || 0), 0)
    const lastHitAt = rows.reduce((latest, row) => Math.max(latest, Number(row.last_hit_at || 0)), 0) || null
    try {
      db.prepare("UPDATE agent_memory_records SET origin='consolidated',confidence=?,access_count=?,adopt_count=?,reject_count=?,repeat_count=?,last_hit_at=? WHERE id=?")
        .run(confidence, sum('access_count'), sum('adopt_count'), sum('reject_count'), sum('repeat_count') + duplicates.length, lastHitAt, survivor.id)
      const archive = db.prepare("UPDATE agent_memory_records SET status='stale',archived_at=?,updated_at=? WHERE id=?")
      for (const row of duplicates) archive.run(at, at, row.id)
      merged += duplicates.length
    } catch { /* 单组失败不影响其它组和主流程 */ }
  }
  return merged
}

export interface MemoryGovernanceResult {
  expired: number
  lowConfidence: number
  archived: number
  consolidated: number
}

/** 过期到期、反复被拒、近重复、保留期归档：一次治理，四个计数。 */
export function maintainMemoryRecords(db: MemoryGovernanceDb, at: number, retentionDays: number): MemoryGovernanceResult {
  const consolidated = consolidateDuplicateMemories(db, at)
  const expired = db.prepare("UPDATE agent_memory_records SET status='stale',updated_at=? WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('approved','pending-review')").run(at, at).changes
  const lowConfidence = db.prepare("UPDATE agent_memory_records SET status='stale',updated_at=? WHERE status='approved' AND reject_count>=3 AND confidence<0.35").run(at).changes
  const cutoff = at - retentionDays * 86400000
  const archived = db.prepare("UPDATE agent_memory_records SET archived_at=?,updated_at=? WHERE status='stale' AND archived_at IS NULL AND updated_at<?").run(at, at, cutoff).changes
  return { expired, lowConfidence, archived, consolidated }
}
