import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { getAgent, AgentRuntimeError } from './agent-runtime'
import { redactAgentText } from '@shared/agent-privacy'
import { MEMORY_INJECTION_RE, MEMORY_SENSITIVE_RE } from '@shared/agent-domain-rules'
import { agentMemoryListQuerySchema, agentMemoryReviewSchema, agentMemorySearchSchema, agentMemoryWriteSchema, type AgentMemoryWrite } from '@shared/schemas/agent-domain'

const MEMORY_FORMAT = 'shopilot-agent-memory'
const MEMORY_VERSION = 1
const DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)])

export function defaultMemoryRoot(): string {
  let base = process.env.APPDATA || process.env.LOCALAPPDATA
  if (!base) {
    try { base = app.getPath('appData') } catch { base = process.cwd() }
  }
  return resolve(join(base, 'ShopPilot', 'agent-memory'))
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

function memoryLimit(type: string): number {
  return type === 'working' ? 8192 : type === 'episodic' ? 16384 : 32768
}
function assertMemoryWriteScope(agentId: string, storeId: string | null): void {
  const agent = getAgent(agentId)
  if (!agent.memoryScope.write && agent.id !== 'root-ceo') throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有写入长期记忆的权限')
  if (storeId && agent.storeScope.storeIds.length && !agent.storeScope.storeIds.includes(storeId)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有该店铺的记忆范围')
  if (agent.memoryScope.storeIds.length && (!storeId || !agent.memoryScope.storeIds.includes(storeId))) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 的记忆范围未包含该店铺')
}
function filePathFor(root: string, agentId: string, memoryId: string): string {
  const path = resolve(join(root, 'agents', agentId, `${memoryId}.md`))
  assertContainedMemoryPath(root, path)
  const agentDir = join(root, 'agents', agentId)
  if (existsSync(agentDir) && lstatSync(agentDir).isSymbolicLink()) throw new AgentRuntimeError('AGENT_MEMORY_PATH_INVALID', 'Agent 记忆目录不能是符号链接')
  return path
}

function updateFts(memoryId: string, title: string, content: string): void {
  try {
    const db = getDatabase()
    const keywords = Array.from(new Set(content.match(/[\p{L}\p{N}]{2,}/gu) || [])).slice(0, 300).join(' ')
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
  if (includeContent) {
    // Search is an explicit content request, but it still returns a bounded
    // excerpt so one IPC response cannot dump an entire memory corpus.
    try { content = redactAgentText(readFileSync(safeMemoryFilePath(memoryRoot(), String(row.file_path)), 'utf8').replace(/^---[\s\S]*?---\n/, ''), 4000) } catch { content = null }
  }
  return {
    id: row.id, agentId: row.agent_id, storeId: row.store_id || null, scope: row.scope, type: row.type,
    title: redactAgentText(row.title, 200), filePath: undefined, contentHash: row.content_hash, confidence: Number(row.confidence),
    sourceJobId: row.source_job_id || null, status: row.status, sensitivity: row.sensitivity, expiresAt: row.expires_at || null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), ...(includeContent ? { content } : {})
  }
}

export function writeMemory(raw: AgentMemoryWrite): any {
  const input = agentMemoryWriteSchema.parse(raw)
  assertMemoryWriteScope(input.agentId, input.storeId)
  if (input.content.length > memoryLimit(input.type)) throw new AgentRuntimeError('AGENT_MEMORY_TOO_LARGE', '记忆正文超过该类型上限')
  const redacted = redactMemoryContent(input.content)
  const root = memoryRoot()
  const id = `mem_${randomUUID()}`
  const body = `---\nid: ${id}\nformat: ${MEMORY_FORMAT}\nversion: ${MEMORY_VERSION}\nagentId: ${input.agentId}\nstoreId: ${input.storeId || ''}\nscope: ${input.scope}\ntype: ${input.type}\nstatus: ${redacted.quarantine ? 'quarantined' : 'pending-review'}\nsourceJobId: ${input.sourceJobId || ''}\n---\n${redacted.content}\n`
  const filePath = filePathFor(root, input.agentId, id)
  const contentHash = hash(body)
  const conflict = getDatabase().prepare('SELECT id FROM agent_memory_records WHERE agent_id=? AND store_id IS ? AND scope=? AND title=? AND content_hash<>? AND status<>? LIMIT 1').get(input.agentId, input.storeId, input.scope, input.title, contentHash, 'stale') as any
  const status = redacted.quarantine ? 'quarantined' : conflict ? 'conflict' : 'pending-review'
  const manifest = readManifest(root)
  const manifestBefore = JSON.parse(JSON.stringify(manifest)) as ReturnType<typeof readManifest>
  manifest.entries = manifest.entries.filter(entry => entry.id !== id)
  manifest.entries.push({ id, path: relative(root, filePath), sha256: contentHash, bytes: Buffer.byteLength(body) })
  const t = Date.now()
  let manifestWritten = false
  try {
    writeAtomic(filePath, body)
    injectMemoryTestFault('write-after-file')
    writeManifest(root, manifest); manifestWritten = true
    injectMemoryTestFault('write-after-manifest')
    getDatabase().transaction(() => {
      if (conflict) getDatabase().prepare("UPDATE agent_memory_records SET status='conflict',updated_at=? WHERE id=?").run(t, conflict.id)
      getDatabase().prepare('INSERT INTO agent_memory_records(id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, input.agentId, input.storeId, input.scope, input.type, redactAgentText(input.title, 200), filePath, contentHash, input.confidence, input.sourceJobId, status, input.sensitivity, input.expiresAt, t, t
      )
    })()
  } catch (error) {
    try { if (existsSync(filePath)) unlinkSync(filePath) } catch { /* best effort after disk/IO failure */ }
    if (manifestWritten) { try { writeManifest(root, manifestBefore) } catch { /* preserve the original failure */ } }
    throw error
  }
  updateFts(id, input.title, redacted.content)
  writeAudit('agent.memory.write', 'success', { actor: input.agentId, storeId: input.storeId, requestId: id })
  return mapMemory(getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(id))
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
  else where.push("status IN ('approved','pending-review')", '(expires_at IS NULL OR expires_at >= ?)')
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
  if (!q) return []
  const storeSql = query.storeId
    ? '(r.store_id IS NULL OR r.store_id=?)'
    : agent.storeScope.storeIds.length || agent.memoryScope.storeIds.length
      ? `(${['r.store_id IS NULL', ...agent.storeScope.storeIds.map(() => 'r.store_id=?'), ...agent.memoryScope.storeIds.map(() => 'r.store_id=?')].join(' OR ')})`
      : '1=1'
  const storeParams = query.storeId
    ? [query.storeId]
    : [...agent.storeScope.storeIds, ...agent.memoryScope.storeIds]
  const statusSql = "r.status IN ('approved','pending-review') AND (r.expires_at IS NULL OR r.expires_at >= ?)"
  const params: any[] = []
  let rows: any[] = []
  try {
    const ftsParams: any[] = [q.split(/\s+/).filter(Boolean).map(token => `"${token}"`).join(' OR ')]
    if (!canReadOtherPrivate) ftsParams.push(agent.id)
    ftsParams.push(...storeParams, Date.now())
    ftsParams.push(query.limit)
    rows = getDatabase().prepare(`SELECT r.* FROM agent_memory_fts f JOIN agent_memory_records r ON r.id=f.memory_id WHERE agent_memory_fts MATCH ? AND ${ownershipSql} AND ${storeSql} AND ${statusSql} ORDER BY bm25(agent_memory_fts) LIMIT ?`).all(...ftsParams) as any[]
  } catch { rows = [] }
  if (!rows.length) {
    const pattern = `%${q}%`
    if (!canReadOtherPrivate) params.push(agent.id)
    params.push(...storeParams, Date.now(), pattern, pattern)
    params.push(query.limit)
    const fallbackOwnershipSql = canReadOtherPrivate ? '1=1' : agent.memoryScope.includeShared ? '(agent_id=? OR scope=\'shared\')' : 'agent_id=?'
    const fallbackStoreSql = storeSql.replace(/r\./g, '')
    const fallbackStatusSql = statusSql.replace(/r\./g, '')
    rows = getDatabase().prepare(`SELECT * FROM agent_memory_records WHERE ${fallbackOwnershipSql} AND ${fallbackStoreSql} AND ${fallbackStatusSql} AND (title LIKE ? OR id IN (SELECT memory_id FROM agent_memory_fts WHERE content LIKE ?)) ORDER BY updated_at DESC LIMIT ?`).all(...params) as any[]
  }
  return rows.filter(row => visibleToAgent(row, agent.id, query.storeId)).map(row => mapMemory(row, true))
}

export function reviewMemory(raw: unknown): any {
  const input = agentMemoryReviewSchema.parse(raw)
  const reviewer = getAgent(input.reviewerAgentId)
  if (reviewer.id !== 'root-ceo' && !reviewer.toolPolicy.tools.includes('review_job')) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 没有审核记忆的权限')
  const row = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(input.memoryId) as any
  if (!row) throw new AgentRuntimeError('AGENT_MEMORY_NOT_FOUND', '记忆记录不存在')
  if (!canAccessMemoryRecord(row, reviewer, row.store_id || null)) throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '当前 Agent 无权审核该范围的记忆')
  if (row.status === 'quarantined' && input.status === 'approved') throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', '隔离记忆不能直接批准')
  getDatabase().prepare('UPDATE agent_memory_records SET status=?,updated_at=? WHERE id=?').run(input.status, Date.now(), input.memoryId)
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
      const body = readFileSync(safeMemoryFilePath(root, String(row.file_path)), 'utf8')
      const actual = hash(body)
      if (actual !== row.content_hash) {
        db.prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=?").run(Date.now(), row.id); quarantined++; continue
      }
      updateFts(row.id, row.title, body.replace(/^---[\s\S]*?---\n/, '')); indexed++
    } catch {
      db.prepare("UPDATE agent_memory_records SET status='quarantined',updated_at=? WHERE id=?").run(Date.now(), row.id); quarantined++
    }
  }
  const manifestHash = hash(JSON.stringify(manifest))
  writeAudit('agent.memory.rebuild', 'success', { requestId: `indexed:${indexed}:quarantined:${quarantined}` })
  return { indexed, quarantined, manifestHash }
}

export function buildApprovedMemoryContext(agentId: string, storeId: string | null, query: string, limit = 12, maxChars = 6000, jobId: string | null = null): string {
  const rows = searchMemories({ agentId, storeId, query, limit: Math.min(50, limit) }).filter(row => row.status === 'approved')
  let used = 0
  const entries = rows.map(row => {
    const text = redactAgentText(row.content || '', 2000)
    if (used + text.length > maxChars) return ''
    used += text.length
    return `<memory id="${row.id}" source="${row.sourceJobId || 'local'}" status="approved">${text.replace(/[<>]/g, '')}</memory>`
  }).filter(Boolean)
  if (jobId && rows.length) {
    const t = Date.now()
    const statement = getDatabase().prepare('INSERT INTO agent_memory_events(id,memory_id,agent_id,job_id,event_type,created_at) VALUES (?,?,?,?,?,?)')
    for (const row of rows) statement.run(`ame_${randomUUID()}`, row.id, agentId, jobId, 'hit', t)
  }
  return `<approved_memory_data>\n${entries.join('\n')}\n</approved_memory_data>`
}

type MemorySnapshotOptions = { skipInvalidRecords?: boolean }

/** AES-GCM snapshot; the data key never leaves Main and is wrapped by safeStorage. */
export function createMemorySnapshot(options: MemorySnapshotOptions = {}): { path: string; sha256: string; bytes: number } {
  if (!safeStorage.isEncryptionAvailable()) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_UNAVAILABLE', '系统安全存储不可用，拒绝创建记忆快照')
  const root = memoryRoot()
  const records = (getDatabase().prepare('SELECT id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at FROM agent_memory_records').all() as any[]).flatMap(row => {
    try {
      const body = readFileSync(safeMemoryFilePath(root, String(row.file_path)), 'utf8')
      if (hash(body) !== row.content_hash) throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', `记忆 ${row.id} hash 不一致，拒绝生成快照`)
      if (MEMORY_SENSITIVE_RE.test(body.replace(/^---[\s\S]*?---\n/, ''))) throw new AgentRuntimeError('AGENT_MEMORY_SENSITIVE', `记忆 ${row.id} 包含敏感凭据，拒绝生成快照`)
      return [{ ...row, body }]
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
 */
export function restoreMemorySnapshot(input: { path: string; actorAgentId: string; confirmed: boolean }): { backupPath: string; restored: number; conflicts: number } {
  const actor = getAgent(input.actorAgentId)
  if (actor.id !== 'root-ceo') throw new AgentRuntimeError('AGENT_PERMISSION_DENIED', '只有 root-ceo 可以恢复记忆快照')
  if (!input.confirmed) throw new AgentRuntimeError('AGENT_CONFIRMATION_REQUIRED', '恢复记忆快照需要用户确认')
  const { payload } = decryptSnapshot(input.path)
  const root = memoryRoot()
  // A damaged entry must not prevent restoring the rest of a verified
  // snapshot. The damaged version remains in the database and the restored
  // body is inserted as a conflict version for review.
  const backup = createMemorySnapshot({ skipInvalidRecords: true })
  const manifest = readManifest(root)
  const manifestBefore = JSON.parse(JSON.stringify(manifest)) as ReturnType<typeof readManifest>
  let restored = 0; let conflicts = 0
  const writes: Array<{ id: string; row: any; body: string; filePath: string; status: string; contentHash: string }> = []
  for (const record of payload.records) {
    if (!record || typeof record.body !== 'string') throw new AgentRuntimeError('AGENT_MEMORY_SNAPSHOT_INVALID', '快照缺少记忆正文')
    const content = record.body.replace(/^---[\s\S]*?---\n/, '')
    const normalized = agentMemoryWriteSchema.parse({ agentId: record.agent_id, storeId: record.store_id || null, scope: record.scope, type: record.type, title: record.title, content, confidence: Number(record.confidence), sourceJobId: record.source_job_id || null, sensitivity: record.sensitivity, expiresAt: record.expires_at || null })
    const redacted = redactMemoryContent(normalized.content)
    if (redacted.content.length > memoryLimit(normalized.type)) throw new AgentRuntimeError('AGENT_MEMORY_TOO_LARGE', '快照中的记忆正文超过上限')
    let id = String(record.id)
    const existing = getDatabase().prepare('SELECT * FROM agent_memory_records WHERE id=?').get(id) as any
    if (existing?.content_hash === String(record.content_hash)) {
      let intact = false
      try {
        const existingBody = readFileSync(safeMemoryFilePath(root, String(existing.file_path)), 'utf8')
        intact = hash(existingBody) === String(existing.content_hash)
      } catch { intact = false }
      if (intact) continue
    }
    let status = ['approved', 'stale', 'pending-review', 'conflict', 'quarantined'].includes(String(record.status)) ? String(record.status) : 'pending-review'
    if (redacted.quarantine) status = 'quarantined'
    if (existing) { id = `mem_restore_${randomUUID()}`; status = 'conflict'; conflicts++ }
    const body = `---\nid: ${id}\nformat: ${MEMORY_FORMAT}\nversion: ${MEMORY_VERSION}\nagentId: ${normalized.agentId}\nstoreId: ${normalized.storeId || ''}\nscope: ${normalized.scope}\ntype: ${normalized.type}\nstatus: ${status}\nsourceJobId: ${normalized.sourceJobId || ''}\n---\n${redacted.content}\n`
    const filePath = filePathFor(root, normalized.agentId, id)
    writes.push({ id, row: { ...normalized, created_at: Number(record.created_at) || Date.now(), updated_at: Number(record.updated_at) || Date.now() }, body, filePath, status, contentHash: hash(body) })
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
        getDatabase().prepare('INSERT INTO agent_memory_records(id,agent_id,store_id,scope,type,title,file_path,content_hash,confidence,source_job_id,status,sensitivity,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id, r.agentId, r.storeId, r.scope, r.type, redactAgentText(r.title, 200), item.filePath, item.contentHash, r.confidence, r.sourceJobId, item.status, r.sensitivity, r.expiresAt, r.created_at, r.updated_at)
        updateFts(item.id, r.title, item.body.replace(/^---[\s\S]*?---\n/, ''))
        restored++
      }
    })()
  } catch (error) {
    for (const item of writes) { try { if (existsSync(item.filePath)) unlinkSync(item.filePath) } catch {} }
    if (manifestWritten) { try { writeManifest(root, manifestBefore) } catch {} }
    throw error
  }
  writeAudit('agent.memory.restore', 'success', { actor: actor.id, requestId: `${restored}:${conflicts}` })
  return { backupPath: backup.path, restored, conflicts }
}

export function setMemoryRoot(root: string): string {
  const safe = assertSafeMemoryRoot(root)
  getDatabase().prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('agent.memory.root', JSON.stringify(safe), Date.now())
  return safe
}
