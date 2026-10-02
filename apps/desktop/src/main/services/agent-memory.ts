import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getDatabase } from '../db/database'
import { writeAudit, auditRequestId } from './audit-logger'
import { assertSingletonJobRow, getAgent, requireSingletonAgentId, AgentRuntimeError } from './agent-runtime'
import { redactAgentText } from '@shared/agent-privacy'
import { MEMORY_INJECTION_RE, MEMORY_SENSITIVE_RE } from '@shared/agent-domain-rules'
import { agentMemoryListQuerySchema, agentMemoryReviewSchema, agentMemorySearchSchema, agentMemoryWriteSchema, type AgentMemoryWrite } from '@shared/schemas/agent-domain'
import { compactTextForContext, estimateAgentTokens } from '@shared/agent-context'
import { verifySnapshotDigest } from '@shared/memory-snapshot'
import { resolveAutoLearningTarget } from '@shared/agent-memory-learning'
// 纯规则集中在 shared、治理 SQL 集中在 agent-memory-governance，I/O 与审核留在本文件：
// 这样「学什么、怎么召回、什么算重复、怎么收敛」都能脱离 electron 被单测覆盖。
import {
  extractDurableMemoryCandidates,
  memoryContextScore,
  memoryKeywords,
  memoryQueryTokens,
  memoryTypeLimit,
  normalizeLearningText
} from '@shared/agent-memory-rules'
import { deriveMemoryDedupeKey, maintainMemoryRecords } from './agent-memory-governance'
import { migrateLegacyAgentMemoryFiles, rewriteAgentMemoryFrontMatter, type AgentMemoryFileMigrationResult } from './agent-memory-agent-migration'
import { ROOT_AGENT_ID } from '@shared/schemas/agent-domain'

const MEMORY_FORMAT = 'shopilot-agent-memory'
const MEMORY_VERSION = 1
const DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)])

/**
 * 默认记忆根目录：**与主数据同处 userData 之下**。
 *
 * 曾经写死 `%APPDATA%\ShopPilot\agent-memory`（大写 P），而 `app.getPath('userData')`
 * 是 `%APPDATA%\shopilot`（跟随 package.json 的 name）——Windows 上就是两个目录。
 * 后果（2026-09-28 审查实测两个目录同时存在）：备份、诊断包、卸载清理全都以 userData 为界，
 * 于是"备份了整个数据库"却**漏掉了模型记忆文件**，卸载也不会清它。
 * 老目录由 [[migrateLegacyMemoryRoot]] 一次性搬过来。
 */
export function defaultMemoryRoot(): string {
  try {
    return resolve(join(app.getPath('userData'), 'agent-memory'))
  } catch { /* app 尚未 ready 等极端情况，退回环境变量 */ }
  let base = process.env.APPDATA || process.env.LOCALAPPDATA
  if (!base) {
    try { base = app.getPath('appData') } catch { base = process.cwd() }
  }
  return resolve(join(base, 'shopilot', 'agent-memory'))
}

/** 历史（大写 P）记忆根：仅迁移用，不再作为默认值 */
function legacyMemoryRoot(): string {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA
  if (!base) return ''
  return resolve(join(base, 'ShopPilot', 'agent-memory'))
}

/**
 * 把历史遗留的记忆根搬到 userData 之下（一次性）。
 *
 * 只在"用户没手工设过 `agent.memory.root` + 新目录不存在 + 老目录存在"时执行。
 * 顺序刻意设计成"先复制、再改库、最后删老目录"：
 *   · 任何一步失败都仍是**可读**状态——库里的绝对路径要么指老目录（老目录还在），
 *     要么指新目录（文件已复制过去）；
 *   · 先删老目录再复制的话，中途失败就会得到"库指着已经不存在的文件"= 记忆全丢。
 */
export function migrateLegacyMemoryRoot(): { moved: boolean; from?: string; to?: string; reason?: string } {
  try {
    const legacy = legacyMemoryRoot()
    if (!legacy) return { moved: false, reason: 'no-legacy-base' }
    const target = defaultMemoryRoot()
    if (resolve(legacy) === resolve(target)) return { moved: false, reason: 'same-path' }
    const configured = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get('agent.memory.root') as any
    if (configured?.value_json) return { moved: false, reason: 'custom-root' }
    if (!existsSync(legacy)) return { moved: false, reason: 'no-legacy-dir' }
    if (existsSync(target)) return { moved: false, reason: 'target-exists' }

    // 1) 复制（不 move）：失败时老目录原封不动，库也还没改
    mkdirSync(target, { recursive: true })
    cpSync(legacy, target, { recursive: true })
    // 2) 改库里的绝对路径（记忆记录是唯一存绝对路径的地方；manifest 存的是相对路径）
    const db = getDatabase()
    const rows = db.prepare('SELECT id, file_path FROM agent_memory_records WHERE file_path LIKE ?').all(`${legacy}%`) as any[]
    db.transaction(() => {
      const upd = db.prepare('UPDATE agent_memory_records SET file_path = ? WHERE id = ?')
      for (const row of rows) upd.run(String(row.file_path).replace(legacy, target), row.id)
    })()
    // 3) 老目录尽力删除：删不掉只是留个垃圾目录，不影响正确性
    let removed = false
    try { rmSync(legacy, { recursive: true, force: true }); removed = true } catch { /* 被占用就留着 */ }
    writeAudit('agent.memory.rebuild', 'success', { requestId: `root-migrate:${rows.length}条${removed ? '' : '/老目录未删'}` })
    return { moved: true, from: legacy, to: target }
  } catch (error: any) {
    return { moved: false, reason: `error:${String(error?.message || error).slice(0, 120)}` }
  }
}

/**
 * Move legacy per-Agent memory files after the database ownership migration.
 * Public Markdown is rewritten in place; private envelopes are decrypted and
 * re-encrypted through the existing safeStorage helpers so their front matter
 * and integrity hash remain valid.  A failed item stays in its old directory
 * and is reported for the next startup pass.
 */
export function migrateLegacyAgentMemoryFilesToRoot(): AgentMemoryFileMigrationResult {
  const root = memoryRoot()
  return migrateLegacyAgentMemoryFiles({
    root,
    rootAgentId: ROOT_AGENT_ID,
    db: getDatabase(),
    rewriteStored: (stored, oldPath, _targetPath) => {
      if (oldPath.toLowerCase().endsWith('.mem.enc')) {
        const body = decodeMemoryFile(stored, oldPath)
        const migratedBody = rewriteAgentMemoryFrontMatter(body, ROOT_AGENT_ID)
        return { stored: encodeMemoryFile(migratedBody, 'private') }
      }
      return { stored: rewriteAgentMemoryFrontMatter(stored, ROOT_AGENT_ID) }
    },
    equivalentStored: (existing, targetPath, desired) => {
      if (targetPath.toLowerCase().endsWith('.mem.enc')) {
        try { return decodeMemoryFile(existing, targetPath) === decodeMemoryFile(desired, targetPath) } catch { return existing === desired }
      }
      return existing === desired
    }
  })
}

function isDeviceName(segment: string): boolean {
  return DEVICE_NAMES.has(segment.replace(/[. ]+$/g, '').toUpperCase())
}

/** Validate containment without following a user supplied symlink outside the root. */
export function assertSafeMemoryRoot(input: string, allowMissing = true): string {
  const root = resolve(String(input || ''))
  if (!isAbsolute(root) || root.length < 4) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆根目录必须是绝对路径')
  if (root.split(/[\\/]+/).some(isDeviceName)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径包含 Windows 设备名')
  if (existsSync(root)) {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆根目录必须是非符号链接目录')
    const real = realpathSync(root)
    if (resolve(real) !== root) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆根目录 realpath 不一致')
  } else if (!allowMissing) {
    throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆根目录不存在')
  } else {
    let cursor = root
    while (!existsSync(cursor) && dirname(cursor) !== cursor) cursor = dirname(cursor)
    if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || resolve(realpathSync(cursor)) !== resolve(cursor))) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径祖先不能是符号链接')
    const realParent = realpathSync(cursor)
    const suffix = relative(cursor, root)
    if (suffix.split(/[\\/]+/).filter(Boolean).some(isDeviceName)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径包含 Windows 设备名')
    if (!resolve(join(realParent, suffix)).startsWith(resolve(realParent) + sep) && resolve(join(realParent, suffix)) !== resolve(realParent)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径逃逸')
  }
  return root
}

function assertContainedMemoryPath(root: string, input: string, allowMissing = true): string {
  const rootAbs = resolve(root)
  const target = resolve(String(input || ''))
  const rel = relative(rootAbs, target)
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]+/).some(isDeviceName)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径必须位于记忆根目录内')
  const realRoot = resolve(realpathSync(rootAbs))
  let cursor = rootAbs
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment)
    if (!existsSync(cursor)) break
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径不能经过符号链接')
    const realCursor = resolve(realpathSync(cursor))
    const realRel = relative(realRoot, realCursor)
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆路径 realpath 逃逸')
  }
  if (!allowMissing && !existsSync(target)) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '记忆文件不存在')
  return target
}

function memoryRoot(): string {
  const configured = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get('agent.memory.root') as any
  let raw = defaultMemoryRoot()
  if (configured?.value_json) {
    try { raw = String(JSON.parse(configured.value_json)) } catch { raw = String(configured.value_json) }
  }
  const root = assertSafeMemoryRoot(raw)
  mkdirSync(join(root, 'agents'), { recursive: true })
  return root
}

function hash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex') }
function tempPath(path: string): string { return `${path}.tmp-${process.pid}-${randomUUID()}` }
/** Deterministic I/O faults are available only to the local acceptance
 * harness. They are never enabled by renderer input or normal app launches. */
function injectMemoryTestFault(stage: string): void {
  if (process.env.SHOPILOT_ACCEPTANCE !== '1') return
  const requested = String(process.env.SHOPILOT_MEMORY_TEST_FAULT || '')
  const aliases: Record<string, string[]> = {
    'atomic-before-rename': ['power-loss-before-rename'],
    'write-after-file': ['disk-full-after-file'],
    'write-after-manifest': ['disk-full-after-manifest'],
    'snapshot-before-rename': ['snapshot-power-loss-before-rename']
  }
  if (requested === stage || aliases[stage]?.includes(requested)) {
    throw new AgentRuntimeError('AGENT_MEMORY_IO_FAILED', `验收故障注入：${stage}`)
  }
}
function writeAtomic(path: string, content: string, faultStage = 'atomic-before-rename'): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPath(path)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
    injectMemoryTestFault(faultStage)
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    throw error
  }
}

function manifestPath(root: string): string { return join(root, 'manifest.json') }
function readManifest(root: string): { format: string; version: number; entries: Array<{ id: string; path: string; sha256: string; bytes: number }> } {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(root), 'utf8'))
    if (parsed?.format !== MEMORY_FORMAT || parsed?.version !== MEMORY_VERSION || !Array.isArray(parsed.entries)) throw new Error('bad manifest')
    return parsed
  } catch {
    return { format: MEMORY_FORMAT, version: MEMORY_VERSION, entries: [] }
  }
}
function writeManifest(root: string, manifest: ReturnType<typeof readManifest>): void {
  writeAtomic(manifestPath(root), JSON.stringify({ ...manifest, generatedAt: Date.now() }, null, 2))
}

function redactMemoryContent(content: string): { content: string; quarantine: boolean } {
  if (MEMORY_SENSITIVE_RE.test(content)) throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', '记忆候选包含 API Key、Token、Cookie 或密码，拒绝写入')
  const redacted = redactAgentText(content, 32768)
  return { content: redacted, quarantine: MEMORY_INJECTION_RE.test(redacted) }
}

function memorySettingNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get(key) as any
    const parsed = row?.value_json == null ? fallback : Number(JSON.parse(String(row.value_json)))
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  } catch { return fallback }
}

function memorySettingEnabled(key: string, fallback = true): boolean {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get(key) as any
    if (row?.value_json == null) return fallback
    const raw = String(row.value_json).replace(/^"|"$/g, '').toLowerCase()
    return raw === 'true' || raw === '1' || raw === 'yes'
  } catch { return fallback }
}

function learningHash(value: unknown): string {
  return hash(normalizeLearningText(value, 12000).toLowerCase())
}

/**
 * 近重复指纹。规范正文与哈希都在可单测的模块里实现，这里只做转发，
 * 保证写入路径与治理路径用的是同一把钥匙。
 */
function memoryDedupeKey(content: unknown): string | null {
  return deriveMemoryDedupeKey(content)
}
function assertMemoryWriteScope(agentId: string, storeId: string | null): void {
  const agent = requireSingletonAgentId(agentId, '记忆写入')
  if (!agent.memoryScope.write) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', 'root-ceo 当前没有写入长期记忆的权限')
  if (storeId && agent.storeScope.storeIds.length && !agent.storeScope.storeIds.includes(storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有该店铺的记忆范围')
  if (agent.memoryScope.storeIds.length && (!storeId || !agent.memoryScope.storeIds.includes(storeId))) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的记忆范围未包含该店铺')
}
function filePathFor(root: string, agentId: string, memoryId: string, scope?: string): string {
  const extension = scope === 'private' ? '.mem.enc' : '.md'
  const path = resolve(join(root, 'agents', agentId, `${memoryId}${extension}`))
  assertContainedMemoryPath(root, path)
  const agentDir = join(root, 'agents', agentId)
  if (existsSync(agentDir) && lstatSync(agentDir).isSymbolicLink()) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', 'Agent 记忆目录不能是符号链接')
  return path
}

const PRIVATE_MEMORY_FORMAT = 'shopilot-agent-private-memory'
const PRIVATE_MEMORY_VERSION = 1

/** Private memory files are encrypted with a per-file key wrapped by the OS
 * safeStorage key. The wrapped key and ciphertext never enter Renderer or DB. */
function encodeMemoryFile(body: string, scope: string): string {
  if (scope !== 'private') return body
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_UNAVAILABLE', '系统安全存储不可用，拒绝写入 private 记忆')
  const dataKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
  const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()])
  return JSON.stringify({
    format: PRIVATE_MEMORY_FORMAT,
    version: PRIVATE_MEMORY_VERSION,
    wrappedKey: safeStorage.encryptString(dataKey.toString('base64')).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64')
  })
}

function decodeMemoryFile(stored: string, filePath: string): string {
  // Existing v1 public/store records are plaintext .md. Only the private
  // extension opts into the encrypted envelope, so old libraries remain
  // readable and can be migrated by an explicit rewrite/restore.
  if (!filePath.toLowerCase().endsWith('.mem.enc')) return stored
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_UNAVAILABLE', '系统安全存储不可用，无法读取 private 记忆')
  try {
    const envelope = JSON.parse(stored)
    if (envelope?.format !== PRIVATE_MEMORY_FORMAT || envelope?.version !== PRIVATE_MEMORY_VERSION) throw new Error('bad private memory envelope')
    const dataKey = Buffer.from(safeStorage.decryptString(Buffer.from(String(envelope.wrappedKey), 'base64')), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(String(envelope.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new AgentRuntimeError('AGENT_MEMORY_INTEGRITY_FAILED', 'private 记忆解密或完整性校验失败')
  }
}

function readMemoryFile(root: string, input: string): { stored: string; body: string; path: string } {
  const path = safeMemoryFilePath(root, input)
  const stored = readFileSync(path, 'utf8')
  return { stored, body: decodeMemoryFile(stored, path), path }
}

function updateFts(memoryId: string, title: string, content: string): void {
  try {
    const db = getDatabase()
    const keywords = memoryKeywords(`${title} ${content}`)
    db.prepare('DELETE FROM agent_memory_fts WHERE memory_id=?').run(memoryId)
    db.prepare('INSERT INTO agent_memory_fts(memory_id,title,content,keywords) VALUES (?,?,?,?)').run(memoryId, title, content, keywords)
  } catch {
    // Index is explicitly rebuildable; the memory remains authoritative.
  }
}

function snapshotSafePath(path: string): { root: string; safePath: string } {
  const root = memoryRoot()
  const safePath = assertContainedMemoryPath(root, path, false)
  if (lstatSync(safePath).isSymbolicLink()) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', '快照路径不存在或不能是符号链接')
  return { root, safePath }
}

function safeMemoryFilePath(root: string, input: string): string {
  return assertContainedMemoryPath(root, input, false)
}

function decryptSnapshot(path: string): { safePath: string; payload: any } {
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_UNAVAILABLE', '系统安全存储不可用，拒绝恢复记忆快照')
  const { safePath } = snapshotSafePath(path)
  let envelope: any
  try { envelope = JSON.parse(readFileSync(safePath, 'utf8')) } catch { throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', '记忆快照不是有效 JSON') }
  if (envelope?.format !== MEMORY_FORMAT || envelope?.version !== MEMORY_VERSION) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', '记忆快照格式或版本不受支持')
  try {
    const dataKey = Buffer.from(safeStorage.decryptString(Buffer.from(String(envelope.wrappedKey), 'base64')), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(String(envelope.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), 'base64')), decipher.final()])
    const payload = JSON.parse(plain.toString('utf8'))
    if (payload?.format !== MEMORY_FORMAT || payload?.version !== MEMORY_VERSION || !Array.isArray(payload.records)) throw new Error('bad payload')
    return { safePath, payload }
  } catch { throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', '快照解密或完整性校验失败') }
}

function mapMemory(row: any, includeContent = false): any {
  let content: string | null = null
  let integrityValid = true
  if (includeContent) {
    // Search is an explicit content request, but it still returns a bounded
    // excerpt so one IPC response cannot dump an entire memory corpus.
    try {
      const file = readMemoryFile(memoryRoot(), String(row.file_path))
      // Revalidate the file hash at the point it is about to enter a model
      // prompt.  Rebuilding FTS is not enough when a file changes afterwards.
      if (hash(file.stored) !== String(row.content_hash)) throw new AgentRuntimeError('AGENT_MEMORY_INTEGRITY_FAILED', '记忆文件 hash 不一致')
      content = redactAgentText(file.body.replace(/^---[\s\S]*?---\n/, ''), 4000)
    } catch {
      content = null
      integrityValid = false
      try { getDatabase().prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=? AND status<>'quarantined'").run(Date.now(), row.id) } catch { /* best effort quarantine */ }
    }
  }
  return {
    id: row.id, agentId: row.agent_id, storeId: row.store_id || null, scope: row.scope, type: row.type,
    title: redactAgentText(row.title, 200), filePath: undefined, contentHash: row.content_hash, confidence: Number(row.confidence),
    sourceJobId: row.source_job_id || null, status: row.status, sensitivity: row.sensitivity, expiresAt: row.expires_at || null,
    origin: row.origin || 'manual', sourceRef: row.source_ref || null,
    accessCount: Number(row.access_count || 0), adoptCount: Number(row.adopt_count || 0), rejectCount: Number(row.reject_count || 0),
    repeatCount: Number(row.repeat_count || 0),
    lastHitAt: row.last_hit_at == null ? null : Number(row.last_hit_at),
    lastFeedbackAt: row.last_feedback_at == null ? null : Number(row.last_feedback_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), ...(includeContent ? { content, integrityValid } : {})
  }
}

export function writeMemory(raw: AgentMemoryWrite): any {
  const input = agentMemoryWriteSchema.parse(raw)
  assertMemoryWriteScope(input.agentId, input.storeId)
  if (input.sourceJobId) {
    const sourceJob = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.sourceJobId) as any
    if (!sourceJob) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', '记忆来源 Agent Job 不存在')
    assertSingletonJobRow(sourceJob, '记忆来源 Agent Job')
  }
  if (input.content.length > memoryTypeLimit(input.type)) throw new AgentRuntimeError('AGENT_MEMORY_TOO_LARGE', '记忆正文超过该类型上限')
  const redacted = redactMemoryContent(input.content)
  const root = memoryRoot()
  // Automatic learners may observe the same conversation/job more than once
  // after a renderer retry.  The source reference is a stable idempotency key
  // and returns the existing candidate instead of creating a duplicate.
  if (input.sourceRef) {
    const existing = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE source_ref=? AND agent_id=? AND store_id IS ? ORDER BY updated_at DESC LIMIT 1').get(input.sourceRef, input.agentId, input.storeId) as any
    if (existing) return { ...mapMemory(existing), created: false }
  }
  // 近重复收敛：同一个 Agent/店铺/范围/类型下，规范正文相同的记忆不再新建第二条，
  // 而是记一次「重复观察」（提升置信度与新鲜度）。这样对话规则被反复提及、
  // 或同一句反馈跨 Job 再次出现时，记忆库不会无限堆积同义条目。
  // 隔离记录不参与去重（每次可疑写入都保留证据），也绝不会因为重复而自动批准。
  const dedupeKey = memoryDedupeKey(redacted.content)
  if (dedupeKey) {
    const duplicate = getDatabase().prepare(
      "SELECT * FROM agent_memory_records WHERE dedupe_key=? AND agent_id=? AND store_id IS ? AND scope=? AND type=? AND archived_at IS NULL AND status<>'quarantined' ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending-review' THEN 1 ELSE 2 END, confidence DESC, updated_at ASC LIMIT 1"
    ).get(dedupeKey, input.agentId, input.storeId, input.scope, input.type) as any
    if (duplicate) {
      const repeatedAt = Date.now()
      getDatabase().prepare('UPDATE agent_memory_records SET repeat_count=COALESCE(repeat_count,0)+1,confidence=MAX(COALESCE(confidence,0),?),updated_at=? WHERE id=?').run(input.confidence, repeatedAt, duplicate.id)
      return { ...mapMemory(getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(duplicate.id)), created: false, duplicate: true }
    }
  }
  const id = `mem_${randomUUID()}`
  const requireReview = input.origin === 'manual' || memorySettingEnabled('agent.memory.autoLearn.requireReview', true)
  const status = redacted.quarantine ? 'quarantined' : requireReview ? 'pending-review' : 'approved'
  const body = `---\nid: ${id}\nformat: ${MEMORY_FORMAT}\nversion: ${MEMORY_VERSION}\nagentId: ${input.agentId}\nstoreId: ${input.storeId || ''}\nscope: ${input.scope}\ntype: ${input.type}\nstatus: ${status}\norigin: ${input.origin}\nsourceJobId: ${input.sourceJobId || ''}\nsourceRef: ${input.sourceRef || ''}\n---\n${redacted.content}\n`
  const initialStored = encodeMemoryFile(body, input.scope)
  const filePath = filePathFor(root, input.agentId, id, input.scope)
  const contentHash = hash(initialStored)
  const conflict = getDatabase().prepare('SELECT id FROM agent_memory_records WHERE agent_id=? AND store_id IS ? AND scope=? AND title=? AND content_hash<>? AND status<>? AND (source_ref IS NULL OR source_ref<>?) LIMIT 1').get(input.agentId, input.storeId, input.scope, input.title, contentHash, 'stale', input.sourceRef) as any
  const finalStatus = redacted.quarantine ? 'quarantined' : conflict ? 'conflict' : status
  const finalBody = finalStatus === status ? body : body.replace(`status: ${status}`, `status: ${finalStatus}`)
  const finalStored = encodeMemoryFile(finalBody, input.scope)
  const finalHash = hash(finalStored)
  const manifest = readManifest(root)
  const manifestBefore = JSON.parse(JSON.stringify(manifest)) as ReturnType<typeof readManifest>
  manifest.entries = manifest.entries.filter(entry => entry.id !== id)
  manifest.entries.push({ id, path: relative(root, filePath), sha256: finalHash, bytes: Buffer.byteLength(finalStored) })
  const t = Date.now()
  let manifestWritten = false
  try {
    writeAtomic(filePath, finalStored)
    injectMemoryTestFault('write-after-file')
    writeManifest(root, manifest); manifestWritten = true
    injectMemoryTestFault('write-after-manifest')
    getDatabase().transaction(() => {
      if (conflict) getDatabase().prepare("UPDATE agent_memory_records SET status='conflict',updated_at=? WHERE id=?").run(t, conflict.id)
      getDatabase().prepare('INSERT INTO agent_memory_records(id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, input.agentId, input.storeId, input.scope, input.type, redactAgentText(input.title, 200), filePath, finalHash, input.confidence, input.sourceJobId, finalStatus, input.sensitivity, input.expiresAt, t, t, input.origin, input.sourceRef, 0, 0, 0, null, null, null, dedupeKey, 0
      )
    })()
  } catch (error) {
    try { if (existsSync(filePath)) unlinkSync(filePath) } catch { /* best effort after disk/IO failure */ }
    if (manifestWritten) { try { writeManifest(root, manifestBefore) } catch { /* preserve the original failure */ } }
    throw error
  }
  updateFts(id, input.title, redacted.content)
  writeAudit('agent.memory.write', 'success', { actor: input.agentId, storeId: input.storeId, requestId: id })
  return { ...mapMemory(getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(id)), created: true }
}

function canAccessMemoryRecord(row: any, agent: ReturnType<typeof getAgent>, storeId: string | null): boolean {
  const canReadOtherPrivate = agent.id === 'root-ceo' && agent.toolPolicy.canReadOtherAgentPrivateMemory
  if (row.scope === 'private' && row.agent_id !== agent.id && !canReadOtherPrivate) return false
  if (row.scope === 'shared' && !agent.memoryScope.includeShared && row.agent_id !== agent.id) return false
  if (row.agent_id !== agent.id && row.scope !== 'shared' && !canReadOtherPrivate) {
    const allowedAgents = agent.memoryScope.agentIds
    if (allowedAgents.length && !allowedAgents.includes(row.agent_id)) return false
  }
  if (row.store_id && agent.storeScope.storeIds.length && !agent.storeScope.storeIds.includes(row.store_id)) return false
  if (row.store_id && agent.memoryScope.storeIds.length && !agent.memoryScope.storeIds.includes(row.store_id)) return false
  if (storeId && row.store_id && row.store_id !== storeId) return false
  return true
}

function visibleToAgent(row: any, agentId: string, storeId: string | null): boolean {
  const agent = getAgent(agentId)
  if (!canAccessMemoryRecord(row, agent, storeId)) return false
  if (row.expires_at && Number(row.expires_at) < Date.now()) return false
  return ['approved', 'pending-review'].includes(row.status)
}

export function listMemories(raw: unknown): { items: any[]; nextCursor: string | null; hasMore: boolean } {
  const query = agentMemoryListQuerySchema.parse(raw)
  const agent = getAgent(query.agentId)
  if (query.storeId && agent.memoryScope.storeIds.length && !agent.memoryScope.storeIds.includes(query.storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的记忆范围未包含该店铺')
  if (query.storeId && agent.storeScope.storeIds.length && !agent.storeScope.storeIds.includes(query.storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的店铺范围未包含该店铺')
  const canReadOtherPrivate = agent.id === 'root-ceo' && agent.toolPolicy.canReadOtherAgentPrivateMemory
  const params: any[] = canReadOtherPrivate ? [] : [query.agentId]
  const where = [canReadOtherPrivate ? '1=1' : agent.memoryScope.includeShared ? '(agent_id=? OR scope=\'shared\')' : 'agent_id=?']
  if (query.status) where.push('status=?')
  else where.push("status IN ('approved','pending-review')", 'archived_at IS NULL', '(expires_at IS NULL OR expires_at >= ?)')
  if (query.status) params.push(query.status)
  else params.push(Date.now())
  if (agent.storeScope.storeIds.length) {
    where.push('(store_id IS NULL OR store_id IN (' + agent.storeScope.storeIds.map(() => '?').join(',') + '))')
    params.push(...agent.storeScope.storeIds)
  }
  if (agent.memoryScope.storeIds.length) {
    where.push('(store_id IS NULL OR store_id IN (' + agent.memoryScope.storeIds.map(() => '?').join(',') + '))')
    params.push(...agent.memoryScope.storeIds)
  }
  if (query.storeId) { where.push('(store_id IS NULL OR store_id=?)'); params.push(query.storeId) }
  if (query.cursor) { const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|'); if (decoded.length === 2) { where.push('(updated_at < ? OR (updated_at=? AND id<?))'); params.push(Number(decoded[0]), Number(decoded[0]), decoded[1]) } }
  params.push(query.limit + 1)
  const rows = getDatabase().prepare(`SELECT * FROM agent_memory_records WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...params) as any[]
  const visible = rows.filter(row => canAccessMemoryRecord(row, agent, query.storeId) && (query.status ? true : visibleToAgent(row, agent.id, query.storeId)))
  const hasMore = visible.length > query.limit
  const items = visible.slice(0, query.limit).map(row => mapMemory(row))
  const last = items.at(-1)
  return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(`${last.updatedAt}|${last.id}`).toString('base64url') : null }
}

export function searchMemories(raw: unknown): any[] {
  const query = agentMemorySearchSchema.parse(raw)
  const agent = getAgent(query.agentId)
  if (query.storeId && agent.memoryScope.storeIds.length && !agent.memoryScope.storeIds.includes(query.storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的记忆范围未包含该店铺')
  if (query.storeId && agent.storeScope.storeIds.length && !agent.storeScope.storeIds.includes(query.storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的店铺范围未包含该店铺')
  const canReadOtherPrivate = agent.id === 'root-ceo' && agent.toolPolicy.canReadOtherAgentPrivateMemory
  const ownershipSql = canReadOtherPrivate ? '1=1' : agent.memoryScope.includeShared ? '(r.agent_id=? OR r.scope=\'shared\')' : 'r.agent_id=?'
  const q = query.query.replace(/["*:^()]/g, ' ').trim()
  const tokens = memoryQueryTokens(q)
  if (!q || !tokens.length) return []
  const storeSql = query.storeId
    ? '(r.store_id IS NULL OR r.store_id=?)'
    : agent.storeScope.storeIds.length || agent.memoryScope.storeIds.length
      ? `(${['r.store_id IS NULL', ...agent.storeScope.storeIds.map(() => 'r.store_id=?'), ...agent.memoryScope.storeIds.map(() => 'r.store_id=?')].join(' OR ')})`
      : '1=1'
  const storeParams = query.storeId
    ? [query.storeId]
    : [...agent.storeScope.storeIds, ...agent.memoryScope.storeIds]
  const statusSql = "r.status IN ('approved','pending-review') AND r.archived_at IS NULL AND (r.expires_at IS NULL OR r.expires_at >= ?)"
  const params: any[] = []
  let rows: any[] = []
  try {
    const ftsParams: any[] = [tokens.map(token => `"${token}"`).join(' OR ')]
    if (!canReadOtherPrivate) ftsParams.push(agent.id)
    ftsParams.push(...storeParams, Date.now())
    ftsParams.push(query.limit)
    rows = getDatabase().prepare(`SELECT r.* FROM agent_memory_fts f JOIN agent_memory_records r ON r.id=f.memory_id WHERE agent_memory_fts MATCH ? AND ${ownershipSql} AND ${storeSql} AND ${statusSql} ORDER BY bm25(agent_memory_fts) LIMIT ?`).all(...ftsParams) as any[]
  } catch { rows = [] }
  if (!rows.length) {
    const patternList = tokens.map(token => `%${token}%`)
    if (!canReadOtherPrivate) params.push(agent.id)
    params.push(...storeParams, Date.now())
    params.push(query.limit)
    const fallbackOwnershipSql = canReadOtherPrivate ? '1=1' : agent.memoryScope.includeShared ? '(agent_id=? OR scope=\'shared\')' : 'agent_id=?'
    const fallbackStoreSql = storeSql.replace(/r\./g, '')
    const fallbackStatusSql = statusSql.replace(/r\./g, '')
    const matchSql = patternList.map(() => '(title LIKE ? OR id IN (SELECT memory_id FROM agent_memory_fts WHERE content LIKE ? OR keywords LIKE ?))').join(' OR ')
    params.splice(params.length - 1, 0, ...patternList.flatMap(pattern => [pattern, pattern, pattern]))
    rows = getDatabase().prepare(`SELECT * FROM agent_memory_records WHERE ${fallbackOwnershipSql} AND ${fallbackStoreSql} AND ${fallbackStatusSql} AND (${matchSql}) ORDER BY updated_at DESC LIMIT ?`).all(...params) as any[]
  }
  return rows.filter(row => visibleToAgent(row, agent.id, query.storeId)).map(row => mapMemory(row, true)).filter(row => row.integrityValid !== false)
}

export function reviewMemory(raw: unknown): any {
  const input = agentMemoryReviewSchema.parse(raw)
  const reviewer = requireSingletonAgentId(input.reviewerAgentId, '记忆审核')
  const row = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(input.memoryId) as any
  if (!row) throw new AgentRuntimeError('AGENT_MEMORY_NOT_FOUND', '记忆记录不存在')
  if (!canAccessMemoryRecord(row, reviewer, row.store_id || null)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 无权审核该范围的记忆')
  if (row.status === 'quarantined' && input.status === 'approved') throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', '隔离记忆不能直接批准')
  if (input.status === 'approved') {
    try {
      const file = readMemoryFile(memoryRoot(), String(row.file_path))
      if (hash(file.stored) !== String(row.content_hash)) throw new AgentRuntimeError('AGENT_MEMORY_INTEGRITY_FAILED', '记忆文件 hash 不一致，不能批准')
      if (MEMORY_SENSITIVE_RE.test(file.body.replace(/^---[\s\S]*?---\n/, ''))) throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', '记忆正文包含敏感凭据，不能批准')
    } catch (error) {
      try { getDatabase().prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=?").run(Date.now(), input.memoryId) } catch { /* best effort quarantine */ }
      if (error instanceof AgentRuntimeError) throw error
      throw new AgentRuntimeError('AGENT_MEMORY_INTEGRITY_FAILED', '记忆文件不存在或无法读取，不能批准')
    }
  }
  const reviewedAt = Date.now()
  getDatabase().prepare('UPDATE agent_memory_records SET status=?,archived_at=CASE WHEN ?=\'approved\' THEN NULL ELSE archived_at END,updated_at=? WHERE id=?').run(input.status, input.status, reviewedAt, input.memoryId)
  if ((input.status === 'approved' || input.status === 'stale') && row.status !== input.status) {
    try {
      const accepted = input.status === 'approved'
      getDatabase().prepare(`UPDATE agent_memory_records SET ${accepted ? 'adopt_count=COALESCE(adopt_count,0)+1' : 'reject_count=COALESCE(reject_count,0)+1'},last_feedback_at=?,updated_at=updated_at WHERE id=?`).run(reviewedAt, input.memoryId)
      getDatabase().prepare('INSERT INTO agent_memory_events(id,memory_id,agent_id,job_id,event_type,created_at) VALUES (?,?,?,?,?,?)').run(`ame_${randomUUID()}`, input.memoryId, input.reviewerAgentId, row.source_job_id || null, accepted ? 'adopted' : 'rejected', reviewedAt)
    } catch { /* governance counters are optional on pre-v10 databases */ }
  }
  writeAudit('agent.memory.review', 'success', { actor: input.reviewerAgentId, requestId: input.memoryId })
  return mapMemory(getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(input.memoryId))
}

export function rebuildMemoryIndex(): { indexed: number; quarantined: number; manifestHash: string } {
  const root = memoryRoot()
  const db = getDatabase()
  let indexed = 0; let quarantined = 0
  db.prepare('DELETE FROM agent_memory_fts').run()
  const rows = db.prepare('SELECT * FROM agent_memory_records ORDER BY updated_at ASC').all() as any[]
  const manifest = readManifest(root)
  for (const row of rows) {
    try {
      const file = readMemoryFile(root, String(row.file_path))
      const actual = hash(file.stored)
      if (actual !== row.content_hash) {
        db.prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=?").run(Date.now(), row.id); quarantined++; continue
      }
      const content = file.body.replace(/^---[\s\S]*?---\n/, '')
      updateFts(row.id, row.title, content); indexed++
      // v11 之前写入的记忆没有规范指纹，按正文补齐一次，让旧数据也能参与近重复收敛。
      // 单独 try：指纹写入失败绝不能把一条完好的记忆判成损坏而隔离。
      if (!row.dedupe_key) {
        try {
          const key = memoryDedupeKey(content)
          if (key) db.prepare('UPDATE agent_memory_records SET dedupe_key=? WHERE id=?').run(key, row.id)
        } catch { /* 指纹补写失败不影响索引重建 */ }
      }
    } catch {
      db.prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=?").run(Date.now(), row.id); quarantined++
    }
  }
  const manifestHash = hash(JSON.stringify(manifest))
  writeAudit('agent.memory.rebuild', 'success', { requestId: `indexed:${indexed}:quarantined:${quarantined}` })
  return { indexed, quarantined, manifestHash }
}

function escapeMemoryXml(value: unknown): string {
  const replacements: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
  return String(value ?? '').replace(/[&<>"']/g, char => replacements[char] || char)
}

/** 去重 + 按查询相关性排序，得到准备注入的候选切片。 */
function rankMemoryRows(candidates: any[], query: string, limit: number): any[] {
  const terms = memoryQueryTokens(String(query || ''))
  const seen = new Set<string>()
  return candidates
    .filter(row => {
      const key = String(row.contentHash || `${row.title}|${row.content || ''}`)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => memoryContextScore(b, terms) - memoryContextScore(a, terms))
    .slice(0, Math.min(50, Math.max(1, limit)))
}

/**
 * 按 token 预算打包成 <memory> 条目；只有已审核记录会进入这里。
 *
 * 预算侧给的是按最坏情况（全中文）折算的字符份额，所以这里换算成 token 份额后再核算：
 * 中文内容口径与以前一致，而拉丁/JSON 为主的记忆不再只用到约 1/2.7 的容量
 * （最终 compactAgentPrompt 只会缩不会放，欠填充会被固化下来）。
 */
function packMemoryEntries(ranked: any[], maxChars: number): { selected: any[]; entries: string[] } {
  const budgetChars = Math.max(800, Math.floor(maxChars))
  const budgetTokens = Math.max(16, Math.floor(budgetChars / 1.35))
  let usedTokens = 0
  const selected: any[] = []
  const entries: string[] = []
  for (const row of ranked) {
    const remainingChars = (budgetTokens - usedTokens) * 1.35
    if (remainingChars < 120) break
    const title = compactTextForContext(redactAgentText(row.title || '', 200), 160)
    // Keep the beginning and end: the beginning usually carries the rule and
    // the end commonly carries the latest exception/evidence.
    const text = compactTextForContext(redactAgentText(row.content || '', 4000), Math.min(1800, Math.max(120, remainingChars - 150)))
    const entry = `<memory id="${escapeMemoryXml(row.id)}" title="${escapeMemoryXml(title)}" type="${escapeMemoryXml(row.type)}" scope="${escapeMemoryXml(row.scope)}" source="${escapeMemoryXml(row.sourceJobId || 'local')}" status="approved">${escapeMemoryXml(text)}</memory>`
    const entryTokens = estimateAgentTokens(entry)
    if (usedTokens + entryTokens > budgetTokens) continue
    usedTokens += entryTokens
    selected.push(row)
    entries.push(entry)
  }
  return { selected, entries }
}

/** 记录一次真实召回（用于排序反馈）；同一分钟内重复召回只记一次。 */
function recordMemoryHits(rows: any[], agentId: string, jobId: string | null): void {
  if (!rows.length) return
  if (jobId) {
    const job = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId) as any
    if (!job) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', '记忆召回关联的 Agent Job 不存在')
    assertSingletonJobRow(job, '记忆召回关联的 Agent Job')
  }
  const t = Date.now()
  const statement = getDatabase().prepare('INSERT INTO agent_memory_events(id,memory_id,agent_id,job_id,event_type,created_at) VALUES (?,?,?,?,?,?)')
  const hitCutoff = t - 60 * 1000
  for (const row of rows) {
    try {
      // A single agent turn may retrieve memory once per continuation round.
      // Count a hit at most once per minute so ranking feedback reflects real
      // retrievals instead of the number of internal model retries/rounds.
      const changed = getDatabase().prepare('UPDATE agent_memory_records SET access_count=COALESCE(access_count,0)+1,last_hit_at=?,updated_at=updated_at WHERE id=? AND (last_hit_at IS NULL OR last_hit_at<?)').run(t, row.id, hitCutoff).changes
      if (changed) statement.run(`ame_${randomUUID()}`, row.id, agentId, jobId, 'hit', t)
    } catch { /* migration v10 is applied during bootstrap */ }
  }
}

/**
 * Build a ranked, de-duplicated memory slice.  Retrieval is deliberately
 * cheaper than asking the model to summarize memory: approved records are
 * ranked by query overlap, type, confidence and freshness, then packed until
 * the model-specific budget is reached.
 */
export function buildApprovedMemoryContext(agentId: string, storeId: string | null, query: string, limit = 12, maxChars = 6000, jobId: string | null = null): string {
  const candidates = searchMemories({ agentId, storeId, query, limit: Math.min(50, Math.max(1, limit * 4)) })
    .filter(row => row.status === 'approved')
  const ranked = rankMemoryRows(candidates, query, limit)
  const { selected, entries } = packMemoryEntries(ranked, maxChars)
  recordMemoryHits(selected, agentId, jobId)
  return `<approved_memory_data>\n${entries.join('\n')}\n</approved_memory_data>`
}

/**
 * 模型主动检索记忆（searchMemory 工具）时回传的正文。
 *
 * 修复点：这条路径以前只把命中**条数**回给模型，检索到的正文被直接丢掉，
 * 于是模型「主动回忆」拿不到任何内容，只能吃每轮自动注入的那一小片记忆。
 * 现在按同一套预算打包正文，但仍然只回传 approved：待审核候选只报数量，
 * 审核门禁不会因为模型主动查询而被绕过。
 */
export function recallMemories(input: { agentId: string; storeId: string | null; query: string; limit?: number; maxChars?: number; jobId?: string | null }): { text: string; approved: number; pendingReview: number; total: number } {
  const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 5)))
  const rows = searchMemories({ agentId: input.agentId, storeId: input.storeId, query: input.query, limit: Math.min(50, limit * 4) })
  const approvedRows = rows.filter(row => row.status === 'approved')
  const ranked = rankMemoryRows(approvedRows, input.query, limit)
  const { selected, entries } = packMemoryEntries(ranked, input.maxChars ?? 2400)
  recordMemoryHits(selected, input.agentId, input.jobId ?? null)
  return {
    text: entries.length ? `<approved_memory_data>\n${entries.join('\n')}\n</approved_memory_data>` : '',
    approved: entries.length,
    pendingReview: rows.length - approvedRows.length,
    total: rows.length
  }
}

type LearningMessage = { role: 'user' | 'assistant'; text: string }

function autoCandidateAllowed(): boolean {
  return memorySettingEnabled('agent.memory.enabled', true) && memorySettingEnabled('agent.memory.autoLearn', true)
}

function autoCandidateQuotaAvailable(): boolean {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const count = Number((getDatabase().prepare("SELECT COUNT(*) AS c FROM agent_memory_records WHERE origin IN ('conversation','job','feedback','consolidated') AND created_at>=?").get(start.getTime()) as any)?.c || 0)
  return count < memorySettingNumber('agent.memory.maxAutoCandidatesPerDay', 100, 1, 10000)
}

function parseRecord(value: unknown): Record<string, any> | null {
  if (value == null) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null
  } catch { return null }
}

/**
 * Choose the owner of an automatic candidate from the Job's frozen memory
 * scope.  A writable child receives its own private/store candidate so its
 * later turns can learn without leaking into the CEO's private corpus.  If a
 * legacy Job has no usable child snapshot, or the child is no longer writable,
 * the existing root-ceo governance path remains the safe fallback.
 */
function targetForJob(jobId: string, storeId: string | null): ReturnType<typeof resolveAutoLearningTarget> {
  const row = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(jobId) as any
  if (!row) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', '自动学习关联的 Agent Job 不存在')
  assertSingletonJobRow(row, '自动学习关联的 Agent Job')
  const frozenMemory = parseRecord(row?.memory_scope_snapshot_json)
  const frozenStore = parseRecord(row?.store_scope_snapshot_json)
  return resolveAutoLearningTarget({
    rootAgentId: ROOT_AGENT_ID,
    assignedAgentId: String(row?.assigned_agent_id || ROOT_AGENT_ID),
    storeId,
    currentMemoryWrite: true,
    currentMemoryStoreIds: [],
    frozenMemoryWrite: frozenMemory?.write,
    frozenMemoryStoreIds: frozenMemory?.storeIds,
    currentStoreIds: [],
    frozenStoreIds: frozenStore?.storeIds
  })
}

/**
 * Extract durable user preferences and operating rules from a conversation.
 * This is intentionally conservative: only explicit durable-language cues are
 * promoted, the record remains pending-review, and sensitive/instruction-like
 * content is quarantined by writeMemory before it can reach a model.
 * 抽取规则本身是纯函数（shared/agent-memory-rules），这里只负责写库与配额。
 */
export function learnFromConversation(input: { agentId: string; storeId: string | null; messages: LearningMessage[] }): { created: number; skipped: number } {
  // Identity is a hard boundary even when automatic learning is disabled.
  // Validate the caller before the best-effort feature flag can silently
  // return, so a legacy/non-root caller can never use this helper as a
  // side-channel around the single-agent runtime.
  const actor = requireSingletonAgentId(input.agentId, '对话记忆学习')
  if (!autoCandidateAllowed()) return { created: 0, skipped: 0 }
  const candidates = extractDurableMemoryCandidates(input.messages)
  let created = 0; let skipped = 0
  for (const candidate of candidates) {
    if (!autoCandidateQuotaAvailable()) { skipped += 1; break }
    const scope = input.storeId ? 'store' : 'private'
    const sourceRef = `conversation:${learningHash(`${actor.id}|${input.storeId || ''}|${candidate.statement}`)}`
    try {
      const result = writeMemory({
        agentId: actor.id,
        storeId: input.storeId,
        scope,
        type: candidate.type,
        title: candidate.title,
        content: candidate.statement,
        confidence: candidate.confidence,
        sourceJobId: null,
        origin: 'conversation',
        sourceRef,
        sensitivity: 'internal',
        expiresAt: null
      })
      if (result?.created && result?.origin === 'conversation' && result?.sourceRef === sourceRef) created += 1
      else skipped += 1
    } catch (error: any) {
      // Learning is best effort and must never block a user request.  A
      // sensitive candidate is still recorded in the audit/error path by the
      // normal writer; it is simply not promoted here.
      skipped += 1
      if (error?.code !== 'AGENT_MEMORY_SENSITIVE') writeAudit('agent.memory.learn', 'failure', { actor: actor.id, requestId: sourceRef })
    }
  }
  return { created, skipped }
}

/** Build an episodic candidate from a completed Job's persisted evidence. */
export function learnFromJobResults(input: {
  jobId: string
  storeId: string | null
  goal: string
  status: string
  results: Array<{ summary?: string; kind?: string; evidence?: unknown }>
}): { created: number; skipped: number } {
  // Validate the persisted owner before feature flags/quotas can turn an
  // invalid historical Job into a silent success.  Callers may still treat
  // the error as best-effort, but the boundary remains explicit and auditable.
  const target = targetForJob(input.jobId, input.storeId)
  if (!autoCandidateAllowed() || input.status !== 'succeeded' || !input.results.length || !autoCandidateQuotaAvailable()) return { created: 0, skipped: 0 }
  const summaries = input.results.map(item => normalizeLearningText(item.summary, 420)).filter(item => item.length >= 12).slice(0, 6)
  if (!summaries.length) return { created: 0, skipped: 1 }
  const goal = normalizeLearningText(input.goal, 600)
  const content = `任务目标：${goal}\n执行结果：${summaries.join('；')}`
  const sourceRef = `job:${input.jobId}`
  try {
    const result = writeMemory({
      agentId: target.agentId,
      storeId: input.storeId,
      scope: target.scope,
      type: 'episodic',
      title: `任务经验：${goal.slice(0, 88)}`,
      content,
      confidence: 0.58,
      sourceJobId: input.jobId,
      origin: 'job',
      sourceRef,
      sensitivity: 'internal',
      expiresAt: Date.now() + 180 * 86400000
    })
    return { created: result?.created && result?.sourceRef === sourceRef ? 1 : 0, skipped: result?.created && result?.sourceRef === sourceRef ? 0 : 1 }
  } catch (error: any) {
    if (error?.code !== 'AGENT_MEMORY_SENSITIVE') writeAudit('agent.memory.learn', 'failure', { actor: target.agentId, storeId: input.storeId, requestId: sourceRef })
    return { created: 0, skipped: 1 }
  }
}

/** Turn a reviewer correction into a procedural candidate for later approval. */
export function learnFromFeedback(input: { jobId: string; reviewerAgentId: string; correction: string }): { created: number; skipped: number } {
  // Keep the singleton identity gate before all best-effort/early-return
  // paths.  Feedback is a governance input and must never accept a child
  // reviewer merely because automatic learning is currently disabled or the
  // correction is empty.
  const reviewer = requireSingletonAgentId(input.reviewerAgentId, '反馈学习')
  if (!autoCandidateAllowed() || !normalizeLearningText(input.correction, 1200) || !autoCandidateQuotaAvailable()) return { created: 0, skipped: 1 }
  const job = getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.jobId) as any
  if (!job) return { created: 0, skipped: 1 }
  assertSingletonJobRow(job, '反馈学习关联的 Agent Job')
  const correction = normalizeLearningText(input.correction, 1200)
  const sourceRef = `feedback:${learningHash(`${input.jobId}|${correction}`)}`
  const target = targetForJob(input.jobId, job.store_id || null)
  try {
    const result = writeMemory({
      agentId: target.agentId,
      storeId: job.store_id || null,
      scope: target.scope,
      type: 'procedural',
      title: `反馈规则：${normalizeLearningText(job.goal, 76)}`,
      content: `针对任务“${normalizeLearningText(job.goal, 320)}”的修正：${correction}`,
      confidence: 0.74,
      sourceJobId: input.jobId,
      origin: 'feedback',
      sourceRef,
      sensitivity: 'internal',
      expiresAt: null
    })
    return { created: result?.created && result?.sourceRef === sourceRef ? 1 : 0, skipped: result?.created && result?.sourceRef === sourceRef ? 0 : 1 }
  } catch (error: any) {
    if (error?.code !== 'AGENT_MEMORY_SENSITIVE') writeAudit('agent.memory.learn', 'failure', { actor: target.agentId || reviewer.id, requestId: sourceRef })
    return { created: 0, skipped: 1 }
  }
}

/** Apply explicit reviewer feedback to confidence and retrieval quality. */
export function assertMemoryFeedbackAllowed(input: { memoryId: string; agentId: string; jobId: string | null }): void {
  const reviewer = requireSingletonAgentId(input.agentId, '记忆反馈')
  const row = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(input.memoryId) as any
  if (!row) throw new AgentRuntimeError('AGENT_MEMORY_NOT_FOUND', '记忆记录不存在')
  const job = input.jobId ? getDatabase().prepare('SELECT * FROM agent_jobs WHERE id=?').get(input.jobId) as any : null
  if (input.jobId && !job) throw new AgentRuntimeError('AGENT_JOB_NOT_FOUND', 'Agent Job 不存在')
  if (job) assertSingletonJobRow(job, '记忆反馈关联的 Agent Job')
  if (row.source_job_id && input.jobId && String(row.source_job_id) !== String(input.jobId)) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '反馈记忆不属于该 Job')
  if (job?.store_id && row.store_id && String(job.store_id) !== String(row.store_id)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '反馈记忆与 Job 店铺范围不一致')
  if (row.status === 'quarantined') throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', '隔离记忆不能接受模型反馈')
  if (!canAccessMemoryRecord(row, reviewer, job?.store_id || row.store_id || null)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 无权反馈该范围的记忆')
}

export function recordMemoryFeedback(input: { memoryId: string; agentId: string; jobId: string | null; rating: number }): void {
  assertMemoryFeedbackAllowed(input)
  const db = getDatabase()
  const row = db.prepare('SELECT confidence,adopt_count,reject_count FROM agent_memory_records WHERE id=?').get(input.memoryId) as any
  if (!row) return
  const rating = Math.min(5, Math.max(1, Number(input.rating || 3)))
  const delta = rating >= 4 ? 0.035 + (rating - 4) * 0.025 : rating <= 2 ? -0.06 - (2 - rating) * 0.035 : 0
  const confidence = Math.min(1, Math.max(0, Number(row.confidence || 0.5) + delta))
  const adopted = Number(row.adopt_count || 0) + (rating >= 4 ? 1 : 0)
  const rejected = Number(row.reject_count || 0) + (rating <= 2 ? 1 : 0)
  const status = rejected >= 3 && confidence < 0.35 ? 'stale' : undefined
  db.prepare(`UPDATE agent_memory_records SET confidence=?,adopt_count=?,reject_count=?,last_feedback_at=?,status=COALESCE(?,status),updated_at=? WHERE id=?`).run(confidence, adopted, rejected, Date.now(), status || null, Date.now(), input.memoryId)
  try {
    if (rating >= 4 || rating <= 2) db.prepare('INSERT INTO agent_memory_events(id,memory_id,agent_id,job_id,event_type,created_at) VALUES (?,?,?,?,?,?)').run(`ame_${randomUUID()}`, input.memoryId, input.agentId, input.jobId, rating >= 4 ? 'adopted' : 'rejected', Date.now())
  } catch { /* v6/v10 migrations create the table during bootstrap */ }
}

/**
 * Expiry, repeated rejection, duplicate consolidation and retention are deterministic governance only.
 * 具体 SQL 在 agent-memory-governance（无 electron 依赖，可单测）；这里只负责读取策略并记审计。
 */
export function maintainMemories(at = Date.now()): { expired: number; lowConfidence: number; archived: number; consolidated: number } {
  const retentionDays = memorySettingNumber('agent.memory.retentionDays', 180, 7, 3650)
  const result = maintainMemoryRecords(getDatabase(), at, retentionDays)
  if (result.expired || result.lowConfidence || result.archived || result.consolidated) {
    writeAudit('agent.memory.maintenance', 'success', { requestId: `${result.expired}:${result.lowConfidence}:${result.archived}:${result.consolidated}` })
  }
  return result
}

type MemorySnapshotOptions = { skipInvalidRecords?: boolean }

/** AES-GCM snapshot; the data key never leaves Main and is wrapped by safeStorage. */
export function createMemorySnapshot(options: MemorySnapshotOptions = {}): { path: string; sha256: string; bytes: number } {
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_UNAVAILABLE', '系统安全存储不可用，拒绝创建记忆快照')
  const root = memoryRoot()
  const records = (getDatabase().prepare('SELECT id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count FROM agent_memory_records').all() as any[]).flatMap(row => {
    try {
      const file = readMemoryFile(root, String(row.file_path))
      if (hash(file.stored) !== row.content_hash) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', `记忆 ${row.id} hash 不一致，拒绝生成快照`)
      if (MEMORY_SENSITIVE_RE.test(file.body.replace(/^---[\s\S]*?---\n/, ''))) throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', `记忆 ${row.id} 包含敏感凭据，拒绝生成快照`)
      return [{ ...row, body: file.body }]
    } catch (error) {
      if (options.skipInvalidRecords && (!(error instanceof AgentRuntimeError) || error.code === 'AGENT_MEMORY_SNAPSHOT_INVALID')) return []
      throw error
    }
  })
  const snapshot = JSON.stringify({ format: MEMORY_FORMAT, version: MEMORY_VERSION, manifest: readManifest(root), records })
  const dataKey = randomBytes(32)
  const wrappedKey = safeStorage.encryptString(dataKey.toString('base64')).toString('base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
  const encrypted = Buffer.concat([cipher.update(snapshot, 'utf8'), cipher.final()])
  const out = join(root, `snapshot-${Date.now()}-${randomUUID()}.bin`)
  const envelope = JSON.stringify({ format: MEMORY_FORMAT, version: MEMORY_VERSION, wrappedKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') })
  writeAtomic(out, envelope, 'snapshot-before-rename')
  const digest = createHash('sha256').update(readFileSync(out)).digest('hex')
  writeAudit('agent.memory.snapshot', 'success', { requestId: digest.slice(0, 16) })
  return { path: out, sha256: digest, bytes: encrypted.length }
}

/** Verify and decrypt a snapshot in Main.  Restore returns metadata only; a
 * caller still needs an explicit upgrade/rollback decision before writing any
 * database or memory records. */
export function inspectMemorySnapshot(path: string): { format: string; version: number; records: number; sha256: string } {
  const { safePath, payload } = decryptSnapshot(path)
  return { format: payload.format, version: payload.version, records: payload.records.length, sha256: createHash('sha256').update(readFileSync(safePath)).digest('hex') }
}

/**
 * Restore encrypted memory records only after an explicit root-ceo
 * confirmation. Existing records are never silently overwritten: a hash
 * conflict is restored as a new conflict version for review.
 *
 * 2026-09-26 审计 P2：`expectedSha256` 是面板**展示给用户的那份快照摘要**。以前
 * `sha256` 只回传、从不比对，用户看到的和恢复的可能是两个文件（快照被换成另一份、
 * 或在展示后被改写）。现在不一致直接拒绝，并把摘要写进审计。
 */
export function restoreMemorySnapshot(input: { path: string; actorAgentId: string; confirmed: boolean; expectedSha256?: string }): { backupPath: string; restored: number; conflicts: number } {
  const actor = requireSingletonAgentId(input.actorAgentId, '记忆快照恢复')
  if (!input.confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '恢复记忆快照需要用户确认')
  const { payload, safePath } = decryptSnapshot(input.path)
  const actualSha = createHash('sha256').update(readFileSync(safePath)).digest('hex')
  const digestCheck = verifySnapshotDigest(input.expectedSha256, actualSha)
  if (!digestCheck.ok) throw new AgentRuntimeError(digestCheck.code, digestCheck.message)
  const root = memoryRoot()
  // A damaged entry must not prevent restoring the rest of a verified
  // snapshot. The damaged version remains in the database and the restored
  // body is inserted as a conflict version for review.
  const backup = createMemorySnapshot({ skipInvalidRecords: true })
  const manifest = readManifest(root)
  const manifestBefore = JSON.parse(JSON.stringify(manifest)) as ReturnType<typeof readManifest>
  let restored = 0; let conflicts = 0
  const writes: Array<{ id: string; row: any; body: string; filePath: string; status: string; contentHash: string; snapshotRecord: any }> = []
  for (const record of payload.records) {
    if (!record || typeof record.body !== 'string') throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', '快照缺少记忆正文')
    const content = record.body.replace(/^---[\s\S]*?---\n/, '')
    // A snapshot can contain rows written by a pre-migration Agent.  Restore
    // keeps the historical content and governance counters, but ownership is
    // always rewritten to the only runtime identity and its root directory.
    const normalized = agentMemoryWriteSchema.parse({ agentId: ROOT_AGENT_ID, storeId: record.store_id || null, scope: record.scope, type: record.type, title: record.title, content, confidence: Number(record.confidence), sourceJobId: record.source_job_id || null, origin: record.origin || 'manual', sourceRef: record.source_ref || null, sensitivity: record.sensitivity, expiresAt: record.expires_at || null })
    const redacted = redactMemoryContent(normalized.content)
    if (redacted.content.length > memoryTypeLimit(normalized.type)) throw new AgentRuntimeError('AGENT_MEMORY_TOO_LARGE', '快照中的记忆正文超过上限')
    let id = String(record.id)
    const existing = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(id) as any
    if (existing?.content_hash === String(record.content_hash)) {
      let intact = false
      try {
        const existingFile = readMemoryFile(root, String(existing.file_path))
        intact = hash(existingFile.stored) === String(existing.content_hash)
      } catch { intact = false }
      if (intact) continue
    }
    let status = ['approved', 'stale', 'pending-review', 'conflict', 'quarantined'].includes(String(record.status)) ? String(record.status) : 'pending-review'
    if (redacted.quarantine) status = 'quarantined'
    if (existing) { id = `mem_restore_${randomUUID()}`; status = 'conflict'; conflicts++ }
    const body = `---\nid: ${id}\nformat: ${MEMORY_FORMAT}\nversion: ${MEMORY_VERSION}\nagentId: ${normalized.agentId}\nstoreId: ${normalized.storeId || ''}\nscope: ${normalized.scope}\ntype: ${normalized.type}\nstatus: ${status}\norigin: ${normalized.origin}\nsourceJobId: ${normalized.sourceJobId || ''}\nsourceRef: ${normalized.sourceRef || ''}\n---\n${redacted.content}\n`
    const filePath = filePathFor(root, normalized.agentId, id, normalized.scope)
    const storedBody = encodeMemoryFile(body, normalized.scope)
    writes.push({ id, row: { ...normalized, created_at: Number(record.created_at) || Date.now(), updated_at: Number(record.updated_at) || Date.now() }, body: storedBody, filePath, status, contentHash: hash(storedBody), snapshotRecord: record })
  }
  let manifestWritten = false
  try {
    for (const item of writes) {
      writeAtomic(item.filePath, item.body)
      manifest.entries = manifest.entries.filter(entry => entry.id !== item.id)
        manifest.entries.push({ id: item.id, path: relative(root, item.filePath), sha256: item.contentHash, bytes: Buffer.byteLength(item.body) })
    }
    writeManifest(root, manifest); manifestWritten = true
    getDatabase().transaction(() => {
      for (const item of writes) {
        const r = item.row
        // Keep governance counters from the original snapshot record even when
        // a conflicting restore receives a new id and a new front-matter hash.
        const snapshot = item.snapshotRecord || {}
        getDatabase().prepare('INSERT INTO agent_memory_records(id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at,origin,source_ref,access_count,adopt_count,reject_count,last_hit_at,last_feedback_at,archived_at,dedupe_key,repeat_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id, r.agentId, r.storeId, r.scope, r.type, redactAgentText(r.title, 200), item.filePath, item.contentHash, r.confidence, r.sourceJobId, item.status, r.sensitivity, r.expiresAt, r.created_at, r.updated_at, r.origin, r.sourceRef, Number(snapshot.access_count || 0), Number(snapshot.adopt_count || 0), Number(snapshot.reject_count || 0), snapshot.last_hit_at || null, snapshot.last_feedback_at || null, snapshot.archived_at || null, memoryDedupeKey(r.content), Number(snapshot.repeat_count || 0))
        updateFts(item.id, r.title, decodeMemoryFile(item.body, item.filePath).replace(/^---[\s\S]*?---\n/, ''))
        restored++
      }
    })()
  } catch (error) {
    for (const item of writes) { try { if (existsSync(item.filePath)) unlinkSync(item.filePath) } catch {} }
    if (manifestWritten) { try { writeManifest(root, manifestBefore) } catch {} }
    throw error
  }
  writeAudit('agent.memory.restore', 'success', {
    actor: actor.id,
    requestId: auditRequestId(`snapshot:${actualSha.slice(0, 16)}`, `${restored}恢复/${conflicts}冲突${digestCheck.verified ? '/摘要已比对' : '/未提供摘要'}`)
  })
  return { backupPath: backup.path, restored, conflicts }
}

export function setMemoryRoot(root: string): string {
  const safe = assertSafeMemoryRoot(root)
  getDatabase().prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('agent.memory.root', JSON.stringify(safe), Date.now())
  return safe
}

export function getMemoryLearningSettings(): { autoLearn: boolean; retentionDays: number } {
  return {
    autoLearn: memorySettingEnabled('agent.memory.autoLearn', true),
    retentionDays: memorySettingNumber('agent.memory.retentionDays', 180, 7, 3650)
  }
}

export function setMemoryLearningSettings(input: { autoLearn: boolean; retentionDays?: number }): { autoLearn: boolean; retentionDays: number } {
  const retentionDays = memorySettingNumber('agent.memory.retentionDays', Number(input.retentionDays ?? 180), 7, 3650)
  const next = { autoLearn: !!input.autoLearn, retentionDays: Number(input.retentionDays ?? retentionDays) }
  if (!Number.isInteger(next.retentionDays) || next.retentionDays < 7 || next.retentionDays > 3650) throw new AgentRuntimeError('AGENT_INVALID_INPUT', '记忆保留天数必须在 7～3650 天之间')
  const db = getDatabase()
  const t = Date.now()
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('agent.memory.autoLearn', JSON.stringify(next.autoLearn), t)
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('agent.memory.retentionDays', JSON.stringify(next.retentionDays), t)
  writeAudit('agent.memory.maintenance', 'success', { actor: 'root-ceo', requestId: `settings:${next.autoLearn}:${next.retentionDays}` })
  return next
}
