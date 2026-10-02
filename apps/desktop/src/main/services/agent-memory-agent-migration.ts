import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

/**
 * Filesystem part of the single-Agent upgrade.
 *
 * The SQLite migration changes `agent_memory_records.agent_id`, but the file
 * itself is authoritative and can still live below agents/<legacy-id>.  This
 * helper deliberately does not know Electron or safeStorage.  The caller
 * supplies the rewrite function so private `.mem.enc` files can be decrypted,
 * have their front matter updated, and encrypted again with the existing Main
 * process primitives.
 */

export interface AgentMemoryFileMigrationDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  transaction?: (fn: () => void) => () => void
}

export interface AgentMemoryManifestEntry {
  id: string
  path: string
  sha256: string
  bytes: number
}

export interface AgentMemoryManifest {
  format: string
  version: number
  entries: AgentMemoryManifestEntry[]
  [key: string]: unknown
}

export interface RewrittenMemoryFile {
  stored: string
}

export interface AgentMemoryFileMigrationOptions {
  root: string
  rootAgentId: string
  db?: AgentMemoryFileMigrationDb
  rewriteStored?: (stored: string, oldPath: string, targetPath: string) => RewrittenMemoryFile
  /**
   * Compare an existing target with a newly produced target.  This is needed
   * for `.mem.enc`, whose AES-GCM envelope intentionally contains a fresh
   * random key/IV on every rewrite.  Plaintext migrations can omit it and use
   * byte equality.
   */
  equivalentStored?: (existing: string, targetPath: string, desired: string) => boolean
}

export interface AgentMemoryFileMigrationResult {
  scanned: number
  migrated: number
  skipped: number
  conflicts: number
  failed: number
  removed: number
  manifestUpdated: boolean
  errors: string[]
}

type MemoryRecord = {
  id: string
  agent_id?: string
  file_path: string
  content_hash?: string
}

type Candidate = {
  oldPath: string
  targetPath: string
  fileId: string
  extension: '.md' | '.mem.enc'
  oldStored: string
  newStored: string
  oldHash: string
  newHash: string
  row?: MemoryRecord
  manifestId: string
  targetCreated: boolean
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function tempPath(path: string): string {
  return `${path}.tmp-agent-migrate-${process.pid}-${randomUUID()}`
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPath(path)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

function normalizePath(path: string): string {
  // Windows paths are case-insensitive. Lower-casing on every platform also
  // makes the comparison deterministic in the Node-only migration tests.
  return resolve(path).replace(/\\/g, '/').toLowerCase()
}

function relativeManifestPath(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, '/')
}

function isContained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function readManifest(root: string): AgentMemoryManifest | null {
  const path = join(root, 'manifest.json')
  if (!existsSync(path)) return { format: 'shopilot-agent-memory', version: 1, entries: [] }
  try {
    if (lstatSync(path).isSymbolicLink()) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentMemoryManifest
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null
    return { ...parsed, entries: parsed.entries.filter(Boolean).map(entry => ({
      id: String(entry.id), path: String(entry.path), sha256: String(entry.sha256), bytes: Number(entry.bytes)
    })) }
  } catch {
    return null
  }
}

function fileIdFor(path: string): { id: string; extension: '.md' | '.mem.enc' } | null {
  const name = basename(path)
  if (name.endsWith('.mem.enc')) return { id: name.slice(0, -'.mem.enc'.length), extension: '.mem.enc' }
  if (name.endsWith('.md')) return { id: name.slice(0, -'.md'.length), extension: '.md' }
  return null
}

function listCandidates(root: string, rootAgentId: string): string[] {
  const agentsRoot = join(root, 'agents')
  if (!existsSync(agentsRoot)) return []
  if (lstatSync(agentsRoot).isSymbolicLink()) return []
  const paths: string[] = []
  for (const dirent of readdirSync(agentsRoot, { withFileTypes: true }) as any[]) {
    if (!dirent.isDirectory() || dirent.name === rootAgentId) continue
    const agentDir = join(agentsRoot, dirent.name)
    try {
      if (lstatSync(agentDir).isSymbolicLink()) continue
      for (const file of readdirSync(agentDir, { withFileTypes: true }) as any[]) {
        if (!file.isFile()) continue
        const path = join(agentDir, file.name)
        if (fileIdFor(path)) paths.push(path)
      }
    } catch {
      // A directory may disappear while the app is starting. It is safe to
      // leave that legacy directory for the next idempotent startup pass.
    }
  }
  return paths
}

function rollbackTargets(items: Candidate[]): void {
  for (const item of items) {
    if (!item.targetCreated) continue
    try { if (existsSync(item.targetPath)) unlinkSync(item.targetPath) } catch { /* best effort */ }
  }
}

/** Rewrite a memory Markdown front matter agentId without changing its body. */
export function rewriteAgentMemoryFrontMatter(body: string, rootAgentId: string): string {
  const opening = body.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n)/)
  if (!opening) return body
  const newline = opening[1]
  let header = opening[2]
  if (/^agentId\s*:/mi.test(header)) {
    header = header.replace(/^agentId\s*:.*$/mi, `agentId: ${rootAgentId}`)
  } else {
    header = `agentId: ${rootAgentId}${newline}${header}`
  }
  return `---${newline}${header}${opening[3]}---${opening[4]}${body.slice(opening[0].length)}`
}

/**
 * Move all files below agents/<legacy-id> to agents/<root-ceo>.
 *
 * The operation is restart-safe: targets are written first, manifest and
 * SQLite metadata are updated next, and source files are removed last. A
 * target with different content is never overwritten; it is reported as a
 * conflict and the source remains usable.
 */
export function migrateLegacyAgentMemoryFiles(options: AgentMemoryFileMigrationOptions): AgentMemoryFileMigrationResult {
  const result: AgentMemoryFileMigrationResult = {
    scanned: 0, migrated: 0, skipped: 0, conflicts: 0, failed: 0, removed: 0,
    manifestUpdated: false, errors: []
  }
  const root = resolve(options.root)
  const targetDir = join(root, 'agents', options.rootAgentId)
  const manifest = readManifest(root)
  if (!manifest) {
    result.errors.push('manifest-invalid')
    return result
  }
  mkdirSync(targetDir, { recursive: true })
  if (lstatSync(targetDir).isSymbolicLink()) {
    result.errors.push('root-agent-dir-is-symlink')
    return result
  }

  const records = options.db
    ? options.db.prepare('SELECT id,agent_id,file_path,content_hash FROM agent_memory_records').all() as MemoryRecord[]
    : []
  const recordsByPath = new Map<string, MemoryRecord>()
  for (const row of records) {
    const raw = String(row.file_path || '')
    if (!raw) continue
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(join(root, raw))
    recordsByPath.set(normalizePath(absolute), row)
  }
  const manifestByPath = new Map<string, AgentMemoryManifestEntry>()
  for (const entry of manifest.entries) {
    const absolute = isAbsolute(entry.path) ? resolve(entry.path) : resolve(join(root, entry.path))
    manifestByPath.set(normalizePath(absolute), entry)
  }

  const candidates = listCandidates(root, options.rootAgentId)
  result.scanned = candidates.length
  const staged: Candidate[] = []
  for (const oldPath of candidates) {
    const info = fileIdFor(oldPath)
    if (!info || !isContained(root, oldPath)) { result.skipped++; continue }
    const targetPath = join(targetDir, `${info.id}${info.extension}`)
    try {
      if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
        result.conflicts++
        result.errors.push(`target-symlink:${relativeManifestPath(root, targetPath)}`)
        continue
      }
      const oldStored = readFileSync(oldPath, 'utf8')
      const rewritten = options.rewriteStored
        ? options.rewriteStored(oldStored, oldPath, targetPath)
        : { stored: oldStored }
      let newStored = rewritten.stored
      const targetExists = existsSync(targetPath)
      if (targetExists) {
        const targetStored = readFileSync(targetPath, 'utf8')
        const equivalent = options.equivalentStored
          ? options.equivalentStored(targetStored, targetPath, newStored)
          : targetStored === newStored
        if (!equivalent) {
          result.conflicts++
          result.errors.push(`target-conflict:${relativeManifestPath(root, targetPath)}`)
          continue
        }
        // Keep the bytes that are actually on disk. This matters for private
        // AES-GCM envelopes: equivalent plaintext can have a different random
        // IV/key, so hashing the newly generated envelope would corrupt the
        // SQLite/manifest integrity pointers.
        newStored = targetStored
      } else {
        writeAtomic(targetPath, newStored)
        if (readFileSync(targetPath, 'utf8') !== newStored) throw new Error('target-verification-failed')
      }
      const row = recordsByPath.get(normalizePath(oldPath))
      const manifestEntry = manifestByPath.get(normalizePath(oldPath))
      staged.push({
        oldPath, targetPath, fileId: info.id, extension: info.extension,
        oldStored, newStored, oldHash: sha256(oldStored), newHash: sha256(newStored),
        row, manifestId: String(row?.id || manifestEntry?.id || info.id),
        targetCreated: !targetExists
      })
    } catch (error: any) {
      result.failed++
      result.errors.push(`file-failed:${relativeManifestPath(root, oldPath)}:${String(error?.message || error).slice(0, 120)}`)
    }
  }

  if (!staged.length) return result
  const manifestBefore = JSON.stringify(manifest)
  try {
    for (const item of staged) {
      const oldRel = relativeManifestPath(root, item.oldPath)
      const targetRel = relativeManifestPath(root, item.targetPath)
      manifest.entries = manifest.entries.filter(entry => {
        const entryPath = String(entry.path).replace(/\\/g, '/')
        let entryAbsolute = ''
        try { entryAbsolute = resolve(isAbsolute(entryPath) ? entryPath : join(root, entryPath)) } catch { /* keep id/path checks */ }
        const sameOldPath = entryPath === oldRel || (entryAbsolute && normalizePath(entryAbsolute) === normalizePath(item.oldPath))
        const sameTargetPath = entryPath === targetRel || (entryAbsolute && normalizePath(entryAbsolute) === normalizePath(item.targetPath))
        return entry.id !== item.manifestId && !sameOldPath && !sameTargetPath
      })
      manifest.entries.push({ id: item.manifestId, path: targetRel, sha256: item.newHash, bytes: Buffer.byteLength(item.newStored) })
    }
    writeAtomic(join(root, 'manifest.json'), JSON.stringify({ ...manifest, generatedAt: Date.now() }, null, 2))
    result.manifestUpdated = true

    const updateRows = (): void => {
      if (!options.db) return
      const update = options.db.prepare('UPDATE agent_memory_records SET agent_id=?,file_path=?,content_hash=? WHERE id=?')
      for (const item of staged) {
        if (!item.row) continue
        update.run(options.rootAgentId, item.targetPath, item.newHash, item.row.id)
      }
    }
    if (options.db?.transaction) options.db.transaction(updateRows)()
    else updateRows()

    result.migrated = staged.length
    for (const item of staged) {
      try {
        // Do not remove a source that changed while the migration was in
        // flight. Leaving it is safer than deleting a user's newer memory.
        if (existsSync(item.oldPath) && !lstatSync(item.oldPath).isSymbolicLink() && sha256(readFileSync(item.oldPath, 'utf8')) === item.oldHash) {
          unlinkSync(item.oldPath)
          result.removed++
        } else {
          result.errors.push(`source-changed:${relativeManifestPath(root, item.oldPath)}`)
        }
      } catch (error: any) {
        result.errors.push(`source-remove-failed:${relativeManifestPath(root, item.oldPath)}:${String(error?.message || error).slice(0, 120)}`)
      }
    }
  } catch (error: any) {
    try {
      const restored = JSON.parse(manifestBefore)
      writeAtomic(join(root, 'manifest.json'), JSON.stringify({ ...restored, generatedAt: Date.now() }, null, 2))
    } catch { /* preserve the original error */ }
    rollbackTargets(staged)
    result.failed += staged.length
    result.errors.push(`commit-failed:${String(error?.message || error).slice(0, 120)}`)
    result.manifestUpdated = false
  }
  return result
}

