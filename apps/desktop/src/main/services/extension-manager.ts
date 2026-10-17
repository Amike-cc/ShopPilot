/**
 * 本地解包浏览器扩展管理（2026-10-17）。
 *
 * 边界：
 *   · 只从 userData/extensions 加载；渲染层永远不传路径；
 *   · 导入时复制到管理目录，校验 manifest、文件数、总大小、符号链接；
 *   · 每个店铺 Session（persist:store_<id>）独立加载，扩展 storage 也按店隔离；
 *   · 加载失败只标记该扩展，不影响店铺打开；错误文案脱敏后回渲染层。
 *
 * Electron 44：使用 session.extensions.loadExtension（session.loadExtension 已废弃）；
 * 只支持持久 Session、解包目录，且每次启动都要重新加载。
 */
import { app, type Session } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import type { BrowserExtensionItem, BrowserExtensionListResult } from '@shared/contracts/extensions'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { logMain } from './logger'
import { validateExtensionManifest, type NormalizedExtensionManifest } from './extension-manifest'

const SETTINGS_KEY = 'browser.extensions'
const SLUG_PATTERN = /^ext_[a-z0-9]{8}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

interface ExtensionConfig { master: boolean; enabledIds: string[] }
interface ScannedExtension {
  slug: string
  dir: string
  manifest: NormalizedExtensionManifest | null
  sizeBytes: number
  updatedAt: number
  invalidMessage?: string
  invalidCode?: string
}
interface SessionRuntime {
  session: Session
  loaded: Map<string, string>
}

const sessions = new Map<string, SessionRuntime>()
const loadErrors = new Map<string, string>()

function configDefaults(): ExtensionConfig {
  return { master: false, enabledIds: [] }
}

function readConfig(): ExtensionConfig {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value_json?: string } | undefined
    if (!row?.value_json) return configDefaults()
    const parsed = JSON.parse(row.value_json) as Partial<ExtensionConfig>
    return {
      master: parsed.master === true,
      enabledIds: Array.isArray(parsed.enabledIds)
        ? [...new Set(parsed.enabledIds.filter((id): id is string => typeof id === 'string' && SLUG_PATTERN.test(id)))].slice(0, 50)
        : []
    }
  } catch {
    return configDefaults()
  }
}

function writeConfig(config: ExtensionConfig): void {
  getDatabase().prepare(`
    INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify({ master: config.master, enabledIds: [...new Set(config.enabledIds)] }), Date.now())
}

export function getExtensionsRoot(): string {
  return join(app.getPath('userData'), 'extensions')
}

/**
 * 解析要打开/读取的扩展目录（只给主进程用，绝对路径不出 IPC）。
 * 不带 slug 时指向管理根目录；目录不存在时创建，方便用户直接放自己的插件。
 */
export function resolveExtensionDir(slug?: string): string {
  const root = getExtensionsRoot()
  if (!slug) {
    mkdirSync(root, { recursive: true })
    return root
  }
  if (!SLUG_PATTERN.test(slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展 ID 不合法')
  const dir = resolve(root, slug)
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('EXTENSION_NOT_FOUND: 路径不合法')
  if (!existsSync(dir)) throw new Error('EXTENSION_NOT_FOUND: 扩展目录不存在')
  return dir
}

function safeError(error: unknown): string {
  const raw = String((error as any)?.message || error || '加载失败')
  // 内部绝对路径不回渲染层
  return raw.replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<path>').slice(0, 200)
}

function extensionFailure(error: unknown): { code: string; message: string } {
  const raw = String((error as any)?.message || error || '扩展目录无法读取').trim()
  const match = /^(EXTENSION_[A-Z_]+):\s*(.*)$/.exec(raw)
  return {
    code: match?.[1] || 'EXTENSION_INVALID',
    message: (match?.[2] || raw || '扩展目录无法读取').slice(0, 200)
  }
}

/** 递归统计并做安全检查：拒绝符号链接，限制文件数与总大小。 */
function scanSource(dir: string): { files: string[]; bytes: number } {
  const files: string[] = []
  let bytes = 0
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const info = lstatSync(full)
      if (info.isSymbolicLink()) throw new Error('EXTENSION_INVALID: 扩展目录不能包含符号链接')
      if (info.isDirectory()) { walk(full); continue }
      if (!info.isFile()) throw new Error('EXTENSION_INVALID: 扩展目录只能包含普通文件与目录')
      bytes += info.size
      files.push(full)
      if (files.length > MAX_FILES) throw new Error(`EXTENSION_TOO_LARGE: 文件数超过 ${MAX_FILES}`)
      if (bytes > MAX_TOTAL_BYTES) throw new Error('EXTENSION_TOO_LARGE: 扩展总大小超过 20MB')
    }
  }
  walk(dir)
  return { files, bytes }
}

function readManifest(dir: string): { manifest: NormalizedExtensionManifest | null; code?: string; message?: string; updatedAt: number } {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) return { manifest: null, code: 'EXTENSION_INVALID', message: '缺少 manifest.json', updatedAt: 0 }
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(file)
    if (info.isSymbolicLink() || !info.isFile()) {
      return { manifest: null, code: 'EXTENSION_INVALID', message: 'manifest.json 必须是普通文件，不能是符号链接', updatedAt: 0 }
    }
  } catch {
    return { manifest: null, code: 'EXTENSION_INVALID', message: 'manifest.json 无法读取', updatedAt: 0 }
  }
  if (info.size > MAX_MANIFEST_BYTES) return { manifest: null, code: 'EXTENSION_INVALID', message: 'manifest.json 超过 1MB', updatedAt: info.mtimeMs }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const validated = validateExtensionManifest(parsed)
    if (!validated.ok) return { manifest: null, code: validated.code, message: validated.message, updatedAt: info.mtimeMs }
    return { manifest: validated.manifest, updatedAt: info.mtimeMs }
  } catch {
    return { manifest: null, code: 'EXTENSION_INVALID', message: 'manifest.json 不是合法 JSON', updatedAt: info.mtimeMs }
  }
}

function scanInstalled(): ScannedExtension[] {
  const root = getExtensionsRoot()
  if (!existsSync(root)) return []
  const out: ScannedExtension[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue
    const dir = join(root, entry.name)
    const read = readManifest(dir)
    let manifest = read.manifest
    let sizeBytes = 0
    let invalidCode = read.code
    let invalidMessage = read.message
    try {
      sizeBytes = scanSource(dir).bytes
    } catch (error) {
      const failure = extensionFailure(error)
      manifest = null
      invalidCode = failure.code
      invalidMessage = failure.message
    }
    out.push({
      slug: entry.name,
      dir,
      manifest,
      sizeBytes,
      updatedAt: read.updatedAt,
      invalidCode,
      invalidMessage
    })
  }
  return out.sort((a, b) => (a.manifest?.name || a.slug).localeCompare(b.manifest?.name || b.slug, 'zh-CN'))
}

function isLoaded(slug: string): boolean {
  for (const runtime of sessions.values()) if (runtime.loaded.has(slug)) return true
  return false
}

function toItem(scanned: ScannedExtension, config: ExtensionConfig): BrowserExtensionItem {
  const enabled = config.enabledIds.includes(scanned.slug)
  const loadError = loadErrors.get(scanned.slug)
  let status: BrowserExtensionItem['status'] = 'disabled'
  if (!scanned.manifest) status = 'invalid'
  else if (isLoaded(scanned.slug)) status = 'loaded'
  else if (loadError) status = 'load_failed'
  else if (enabled && config.master) status = 'enabled'
  return {
    id: scanned.slug,
    name: scanned.manifest?.name || scanned.slug,
    version: scanned.manifest?.version || '—',
    manifestVersion: scanned.manifest?.manifestVersion || 3,
    enabled,
    status,
    permissions: scanned.manifest?.permissions || [],
    sizeBytes: scanned.sizeBytes,
    updatedAt: scanned.updatedAt,
    loadError: loadError || (scanned.manifest ? undefined : scanned.invalidMessage)
  }
}

export function listExtensions(): BrowserExtensionListResult {
  const config = readConfig()
  return { master: config.master, items: scanInstalled().map(item => toItem(item, config)) }
}

/** 导入：主进程已拿到用户选择的目录；复制到管理目录并校验，不引用原路径。 */
export function importExtensionFromDirectory(sourceDir: string): BrowserExtensionItem {
  const source = resolve(sourceDir)
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error('EXTENSION_INVALID: 选择的不是目录')
  const read = readManifest(source)
  if (!read.manifest) throw new Error(`${read.code || 'EXTENSION_INVALID'}: ${read.message || 'manifest 校验失败'}`)
  const scanned = scanSource(source)
  if (!scanned.files.some(file => file === join(source, 'manifest.json'))) throw new Error('EXTENSION_INVALID: 缺少 manifest.json')

  const root = getExtensionsRoot()
  let slug = ''
  let target = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `ext_${randomBytes(4).toString('hex')}`
    const candidateTarget = join(root, candidate)
    if (!existsSync(candidateTarget)) {
      slug = candidate
      target = candidateTarget
      break
    }
  }
  if (!target) throw new Error('EXTENSION_INVALID: 无法分配扩展标识，请重试')
  mkdirSync(root, { recursive: true })
  try {
    mkdirSync(target)
  } catch {
    throw new Error('EXTENSION_INVALID: 扩展目录正在被占用，请重试')
  }
  try {
    for (const file of scanned.files) {
      const rel = relative(source, file)
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error('EXTENSION_INVALID: 路径穿越')
      const dest = join(target, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file, dest)
    }
  } catch (error) {
    try { rmSync(target, { recursive: true, force: true }) } catch { /* 清理失败不影响原错误 */ }
    throw error
  }
  const installed = scanInstalled().find(item => item.slug === slug)
  if (!installed?.manifest) {
    try { rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
    throw new Error('EXTENSION_INVALID: 复制后的清单校验失败')
  }
  writeAudit('extension.import', 'success', { requestId: slug })
  logMain('info', `[extensions] 导入 ${slug}（${installed.manifest.name}@${installed.manifest.version}）`)
  return toItem(installed, readConfig())
}

/** 把已启用的扩展加载到店铺 Session；失败只标记，不抛出。 */
export async function applyToSession(storeId: string, session: Session): Promise<void> {
  let runtime = sessions.get(storeId)
  if (!runtime || runtime.session !== session) {
    runtime = { session, loaded: new Map() }
    sessions.set(storeId, runtime)
  }
  const config = readConfig()
  if (!config.master) return
  const installed = new Map(scanInstalled().filter(item => item.manifest).map(item => [item.slug, item]))
  for (const slug of config.enabledIds) {
    if (runtime.loaded.has(slug)) continue
    const item = installed.get(slug)
    if (!item) continue
    try {
      const extension = await session.extensions.loadExtension(item.dir, { allowFileAccess: false })
      runtime.loaded.set(slug, extension.id)
      loadErrors.delete(slug)
      logMain('info', `[extensions] 已加载 ${slug} store=${storeId} id=${extension.id}`)
    } catch (error) {
      const message = safeError(error)
      loadErrors.set(slug, message)
      logMain('warn', `[extensions] 加载失败 ${slug} store=${storeId}: ${message}`)
    }
  }
}

function removeFromSessions(slug: string): void {
  for (const runtime of sessions.values()) {
    const electronId = runtime.loaded.get(slug)
    if (!electronId) continue
    try { runtime.session.extensions.removeExtension(electronId) } catch { /* 已卸载/会话销毁 */ }
    runtime.loaded.delete(slug)
  }
}

async function applyToAllSessions(): Promise<void> {
  const config = readConfig()
  if (!config.master) return
  for (const [storeId, runtime] of sessions) {
    await applyToSession(storeId, runtime.session)
  }
}

export async function setExtensionEnabled(slug: string, enabled: boolean): Promise<BrowserExtensionListResult> {
  if (!SLUG_PATTERN.test(slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展 ID 不合法')
  if (!scanInstalled().some(item => item.slug === slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展不存在')
  const config = readConfig()
  config.enabledIds = enabled
    ? [...new Set([...config.enabledIds, slug])]
    : config.enabledIds.filter(id => id !== slug)
  writeConfig(config)
  if (enabled) await applyToAllSessions()
  else removeFromSessions(slug)
  writeAudit(enabled ? 'extension.enable' : 'extension.disable', 'success', { requestId: slug })
  return listExtensions()
}

export async function setExtensionsMaster(enabled: boolean): Promise<BrowserExtensionListResult> {
  const config = readConfig()
  config.master = enabled
  writeConfig(config)
  if (!enabled) {
    for (const slug of scanInstalled().map(item => item.slug)) removeFromSessions(slug)
  } else {
    for (const [storeId, runtime] of sessions) await applyToSession(storeId, runtime.session)
  }
  writeAudit('extension.master', 'success', { requestId: enabled ? 'on' : 'off' })
  return listExtensions()
}

export async function removeExtension(slug: string): Promise<BrowserExtensionListResult> {
  if (!SLUG_PATTERN.test(slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展 ID 不合法')
  const root = getExtensionsRoot()
  const dir = resolve(root, slug)
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('EXTENSION_NOT_FOUND: 路径不合法')
  removeFromSessions(slug)
  loadErrors.delete(slug)
  const config = readConfig()
  config.enabledIds = config.enabledIds.filter(id => id !== slug)
  writeConfig(config)
  try { rmSync(dir, { recursive: true, force: true }) } catch (error) {
    throw new Error(`EXTENSION_REMOVE_FAILED: ${safeError(error)}`)
  }
  writeAudit('extension.remove', 'success', { requestId: slug })
  return listExtensions()
}

export async function reloadExtension(slug: string): Promise<BrowserExtensionListResult> {
  if (!SLUG_PATTERN.test(slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展 ID 不合法')
  if (!scanInstalled().some(item => item.slug === slug)) throw new Error('EXTENSION_NOT_FOUND: 扩展不存在')
  removeFromSessions(slug)
  loadErrors.delete(slug)
  await applyToAllSessions()
  writeAudit('extension.reload', 'success', { requestId: slug })
  return listExtensions()
}

/** 店铺关闭/删除时释放运行时引用（不影响磁盘与配置）。 */
export function forgetSession(storeId: string): void {
  sessions.delete(storeId)
}
