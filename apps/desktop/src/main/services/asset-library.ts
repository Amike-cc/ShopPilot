/**
 * 素材库服务（2026-11-15）。
 *
 * 原图存 `userData/asset-library/<id>.<ext>`，SQLite 只存元数据与列表缩略图。
 * 渲染层永远拿不到本地绝对路径（详情按需读成 data URL），删除/定位也只接受 id，
 * 避免把"素材库"变成任意文件读写原语。
 */
import { app, nativeImage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSET_LIBRARY_LIMITS,
  normalizeAssetName,
  normalizeAssetTags,
  type AssetLibraryItem,
  type AssetLibraryListResult,
  type AssetLibraryReadResult,
  type AssetLibrarySource
} from '@shared/contracts/asset-library'
import { getDatabase } from '../db/database'
import { logMain } from './logger'

export class AssetLibraryError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

function libraryDir(): string {
  const dir = join(app.getPath('userData'), 'asset-library')
  mkdirSync(dir, { recursive: true })
  return dir
}

function assetPath(fileName: string): string {
  // file_name 由主进程生成；仍然只取 basename，杜绝路径穿越。
  const safe = String(fileName || '').replace(/[\\/]/g, '')
  return join(libraryDir(), safe)
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return normalizeAssetTags(parsed)
  } catch {
    return []
  }
}

function mapItem(row: any): AssetLibraryItem {
  return {
    id: String(row.id),
    name: String(row.name || '未命名素材'),
    mimeType: String(row.mime_type || 'image/png'),
    size: Math.max(0, Number(row.size) || 0),
    width: Math.max(0, Number(row.width) || 0),
    height: Math.max(0, Number(row.height) || 0),
    tags: parseTags(row.tags_json),
    source: row.source === 'chat-image' ? 'chat-image' : 'upload',
    thumbUrl: row.thumb_b64 ? `data:image/jpeg;base64,${String(row.thumb_b64)}` : '',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  }
}

/** 生成 480px 以内的 JPEG 缩略图；拿不到尺寸时留空，列表会显示占位图。 */
function makeThumb(buffer: Buffer, width: number, height: number): string {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return ''
    const max = 480
    const scale = Math.min(1, max / Math.max(width, height))
    const resized = scale < 1
      ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
      : image
    const jpeg = resized.toJPEG(78)
    return jpeg.length ? jpeg.toString('base64') : ''
  } catch {
    return ''
  }
}

function fallbackName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `素材 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function insertBuffer(input: {
  buffer: Buffer
  mimeType: string
  name?: unknown
  tags?: unknown
  source?: AssetLibrarySource
}): { item: AssetLibraryItem; duplicate: boolean } {
  const mimeType = String(input.mimeType || '').toLowerCase().split(';')[0]
  const ext = MIME_EXT[mimeType]
  if (!ext) throw new AssetLibraryError('ASSET_TYPE_UNSUPPORTED', '仅支持 PNG、JPEG、WebP 图片')
  if (!input.buffer.length) throw new AssetLibraryError('ASSET_EMPTY', '图片内容为空')
  if (input.buffer.length > ASSET_LIBRARY_LIMITS.maxBytes) {
    throw new AssetLibraryError('ASSET_TOO_LARGE', `单张素材不能超过 ${Math.round(ASSET_LIBRARY_LIMITS.maxBytes / 1024 / 1024)}MB`)
  }

  const image = nativeImage.createFromBuffer(input.buffer)
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize()
  // Electron 的 nativeImage 对 WebP 的支持随平台而异；WebP 仍允许入库（预览走原图 data URL），
  // PNG/JPEG 解码失败则视为坏文件，避免存进一张打不开的素材。
  if (!size.width && mimeType !== 'image/webp') throw new AssetLibraryError('ASSET_INVALID_IMAGE', '无法识别这张图片，请换一张后重试')

  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM asset_library_items WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1').get(sha256) as any
  if (existing) return { item: mapItem(existing), duplicate: true }

  const id = `ast_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const fileName = `${id}.${ext}`
  const target = assetPath(fileName)
  const now = Date.now()
  const name = normalizeAssetName(input.name, fallbackName())
  const tags = normalizeAssetTags(input.tags)
  const source: AssetLibrarySource = input.source === 'chat-image' ? 'chat-image' : 'upload'
  const thumb = makeThumb(input.buffer, size.width, size.height)

  writeFileSync(target, input.buffer)
  try {
    db.prepare(`
      INSERT INTO asset_library_items
        (id, name, file_name, mime_type, size, width, height, tags_json, source, thumb_b64, sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, fileName, mimeType, input.buffer.length, size.width, size.height, JSON.stringify(tags), source, thumb, sha256, now, now)
  } catch (error) {
    try { unlinkSync(target) } catch { /* 文件已不在 */ }
    throw error
  }
  const row = db.prepare('SELECT * FROM asset_library_items WHERE id = ?').get(id)
  logMain('info', `[asset-library] 新增素材 ${id} source=${source} ${size.width}x${size.height} ${input.buffer.length}B`)
  return { item: mapItem(row), duplicate: false }
}

export function addAssetFromDataUrl(input: {
  dataUrl?: string
  name?: unknown
  tags?: unknown
  source?: AssetLibrarySource
}): { item: AssetLibraryItem; duplicate: boolean } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(String(input.dataUrl || '').trim())
  if (!match) throw new AssetLibraryError('ASSET_BAD_DATA_URL', '图片数据格式不受支持（仅支持 PNG/JPEG/WebP base64）')
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  return insertBuffer({ buffer, mimeType: match[1], name: input.name, tags: input.tags, source: input.source })
}

export function listAssets(): AssetLibraryListResult {
  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM asset_library_items ORDER BY updated_at DESC LIMIT ?').all(ASSET_LIBRARY_LIMITS.listLimit) as any[]
  const items = rows.map(mapItem)
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([tag]) => tag)
  return { items, total: items.length, tags }
}

export function readAsset(id: string): AssetLibraryReadResult {
  const row = getDatabase().prepare('SELECT * FROM asset_library_items WHERE id = ?').get(String(id)) as any
  if (!row) throw new AssetLibraryError('ASSET_NOT_FOUND', '素材不存在或已被删除')
  const filePath = assetPath(row.file_name)
  if (!existsSync(filePath)) throw new AssetLibraryError('ASSET_FILE_MISSING', '素材原图丢失，可能被手动删除')
  const buffer = readFileSync(filePath)
  return {
    item: mapItem(row),
    dataUrl: `data:${row.mime_type};base64,${buffer.toString('base64')}`
  }
}

export function updateAsset(input: { id?: string; name?: unknown; tags?: unknown }): AssetLibraryItem {
  const id = String(input.id || '')
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM asset_library_items WHERE id = ?').get(id) as any
  if (!row) throw new AssetLibraryError('ASSET_NOT_FOUND', '素材不存在或已被删除')
  const name = normalizeAssetName(input.name, row.name)
  const tags = normalizeAssetTags(input.tags)
  db.prepare('UPDATE asset_library_items SET name = ?, tags_json = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(tags), Date.now(), id)
  return mapItem(db.prepare('SELECT * FROM asset_library_items WHERE id = ?').get(id))
}

export function removeAsset(id: string): { id: string } {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM asset_library_items WHERE id = ?').get(String(id)) as any
  if (!row) throw new AssetLibraryError('ASSET_NOT_FOUND', '素材不存在或已被删除')
  db.prepare('DELETE FROM asset_library_items WHERE id = ?').run(row.id)
  try {
    const filePath = assetPath(row.file_name)
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch (error) {
    logMain('warn', `[asset-library] 删除原图失败 ${row.id}: ${String((error as Error)?.message || error)}`)
  }
  logMain('info', `[asset-library] 删除素材 ${row.id}`)
  return { id: String(row.id) }
}

/** 只返回受管目录内的真实文件路径，供主进程 shell.showItemInFolder。 */
export function assetFilePathForReveal(id: string): string {
  const row = getDatabase().prepare('SELECT * FROM asset_library_items WHERE id = ?').get(String(id)) as any
  if (!row) throw new AssetLibraryError('ASSET_NOT_FOUND', '素材不存在或已被删除')
  const filePath = assetPath(row.file_name)
  if (!existsSync(filePath)) throw new AssetLibraryError('ASSET_FILE_MISSING', '素材原图丢失，可能被手动删除')
  return filePath
}
