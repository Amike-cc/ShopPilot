/**
 * 素材库契约（2026-11-15）。
 *
 * 素材库是独立 AI 工具：导入/保存图片到本地受管目录，按名称、标签与来源检索，
 * 并可作为「对话生图」的下一轮参考图。这里只放纯逻辑与跨进程共享的限制，
 * 不依赖 vue / electron / node。
 */

export const ASSET_LIBRARY_LIMITS = {
  /** 素材显示名最大长度 */
  name: 120,
  /** 单个标签最大长度 */
  tag: 24,
  /** 单个素材最多标签数 */
  tags: 8,
  /** 单张素材最大字节数（与生图参考图 5MB 上限分开，原图允许更大） */
  maxBytes: 20 * 1024 * 1024,
  /** 单次列表最多返回条数 */
  listLimit: 1000
} as const

export type AssetLibrarySource = 'upload' | 'chat-image'

export interface AssetLibraryItem {
  id: string
  name: string
  mimeType: string
  size: number
  width: number
  height: number
  tags: string[]
  source: AssetLibrarySource
  /** 列表缩略图（data URL）；原图只在打开详情时读取 */
  thumbUrl: string
  createdAt: number
  updatedAt: number
}

export interface AssetLibraryListResult {
  items: AssetLibraryItem[]
  total: number
  /** 当前库中出现过的标签（去重、按使用次数降序） */
  tags: string[]
}

export interface AssetLibraryReadResult {
  item: AssetLibraryItem
  dataUrl: string
}

/** 名称统一成单行、去首尾空白并截断；空值用调用方给的兜底名。 */
export function normalizeAssetName(raw: unknown, fallback = '未命名素材'): string {
  const value = typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim() : ''
  return (value || fallback).slice(0, ASSET_LIBRARY_LIMITS.name)
}

/**
 * 标签收口：接受数组或逗号/顿号/换行分隔的字符串；
 * 去掉开头的 #、去重、单个截断、最多 8 个。
 */
export function normalizeAssetTags(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map(item => String(item ?? ''))
    : String(raw ?? '').split(/[,，、\n]/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const tag = part.replace(/^#+/, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, ASSET_LIBRARY_LIMITS.tag)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= ASSET_LIBRARY_LIMITS.tags) break
  }
  return out
}

/** 素材库页面的本地筛选：名称/标签关键词 + 来源 + 单个标签。 */
export function filterAssetLibraryItems(
  items: readonly AssetLibraryItem[],
  options: { query?: string; source?: AssetLibrarySource | 'all'; tag?: string } = {}
): AssetLibraryItem[] {
  const query = String(options.query || '').trim().toLowerCase()
  const source = options.source || 'all'
  const tag = String(options.tag || '').trim()
  return items.filter(item => {
    if (source !== 'all' && item.source !== source) return false
    if (tag && !item.tags.includes(tag)) return false
    if (!query) return true
    return `${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(query)
  })
}

export function formatAssetSize(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function assetSourceLabel(source: AssetLibrarySource): string {
  return source === 'chat-image' ? 'AI 生成' : '本地上传'
}
