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
  /**
   * 单页条数（2026-11-15 审查后改）。
   *
   * 原来一次返回 1000 条、每条带 480px 缩略图 base64：满库约 40–80MB 字符串走 IPC 进渲染层，
   * 而且每次增删都要全量重传。现在列表按页取，筛选下推到 SQL，页大小 60。
   */
  pageSize: 60,
  /** 单页条数上限（IPC 传入的 limit 会被夹到 [1, maxPageSize]） */
  maxPageSize: 120,
  /** 库容量软上限：条数 */
  maxItems: 2000,
  /** 库容量软上限：总字节（2GB） */
  maxTotalBytes: 2 * 1024 * 1024 * 1024
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

/** 列表查询：筛选条件与分页都由主进程执行，渲染层不再拉全库再本地过滤。 */
export interface AssetLibraryListInput {
  /** 关键词：匹配名称或标签文本 */
  query?: string
  /** 来源筛选，缺省 all */
  source?: AssetLibrarySource | 'all'
  /** 单个标签精确匹配（JSON 数组里出现该标签） */
  tag?: string
  /** 偏移，从 0 开始 */
  offset?: number
  /** 本页条数，缺省 pageSize */
  limit?: number
}

export interface AssetLibraryListResult {
  /** 当前页的素材 */
  items: AssetLibraryItem[]
  /** 符合筛选条件的总条数（不是库总量） */
  total: number
  /** 库里的总条数（容量提示用） */
  libraryTotal: number
  /** 库里的总字节（容量提示用） */
  libraryBytes: number
  /** 全库出现过的标签（去重、按使用次数降序） */
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

/**
 * 列表查询的规范化：非法输入一律夹到合法范围。
 *
 * 渲染层可能传 -1、NaN、1e9 —— 直接拼进 SQL 会变成全表扫描或空页，
 * 所以在主进程真正查询前先过这里。
 */
export function normalizeAssetListInput(raw: AssetLibraryListInput | null | undefined): {
  query: string
  source: AssetLibrarySource | 'all'
  tag: string
  offset: number
  limit: number
} {
  const input = raw || {}
  const query = typeof input.query === 'string' ? input.query.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) : ''
  const tag = typeof input.tag === 'string' ? input.tag.trim().slice(0, ASSET_LIBRARY_LIMITS.tag) : ''
  const source: AssetLibrarySource | 'all' =
    input.source === 'chat-image' || input.source === 'upload' ? input.source : 'all'
  const rawOffset = Number(input.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(Math.floor(rawOffset), 1_000_000) : 0
  const rawLimit = Number(input.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), ASSET_LIBRARY_LIMITS.maxPageSize)
    : ASSET_LIBRARY_LIMITS.pageSize
  return { query, source, tag, offset, limit }
}

/**
 * 关键词 → SQL LIKE 模式（转义 `\` `%` `_`，配合 `ESCAPE '\'` 使用）。
 * exact=true 用于标签精确匹配：标签存在 JSON 数组里，匹配 `"标签"` 比子串更准，
 * 避免「主图」命中「主图2」。
 */
export function assetLikePattern(text: string, exact = false): string {
  const escaped = String(text).replace(/[\\%_]/g, ch => `\\${ch}`)
  return exact ? `%"${escaped}"%` : `%${escaped}%`
}

/** 受管的原图文件名（`ast_<20 位 hex>.<png|jpg|webp>`）；对账只处理这种文件，别的文件一概不动。 */
const ASSET_FILE_PATTERN = /^ast_[a-z0-9]{20}\.(png|jpg|webp)$/i

export function isAssetFileName(name: unknown): boolean {
  return ASSET_FILE_PATTERN.test(String(name || ''))
}

/**
 * 磁盘与数据库的文件对账（纯函数，便于单测）。
 *
 * - orphans：磁盘上有、库里没有 → 可删（应用崩溃在"写文件"和"写行"之间的残留）
 * - missing：库里有、磁盘上没有 → 只报告，不改行（详情页已有「原图丢失」的如实提示）
 */
export function diffAssetFiles(
  dbFileNames: readonly string[],
  diskFileNames: readonly string[]
): { orphans: string[]; missing: string[] } {
  const db = new Set(dbFileNames.map(name => String(name || '')).filter(Boolean))
  const disk = new Set(diskFileNames.map(name => String(name || '')).filter(name => isAssetFileName(name)))
  return {
    orphans: [...disk].filter(name => !db.has(name)).sort(),
    missing: [...db].filter(name => !disk.has(name)).sort()
  }
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
