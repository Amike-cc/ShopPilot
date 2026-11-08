/**
 * 插件中心（内置目录）契约与纯函数。
 *
 * 设计边界（2026-11-08）：
 *   · 目录随安装包一起发（`assets/browser-extensions` → resources），**不做远端下载**：
 *     没有网络也能装、装的东西可溯源到发布包，不引入"从 URL 拉一段代码进店铺页面"的口子；
 *   · 目录清单只声明展示信息与子目录名，扩展本体仍按 `extension-manifest.ts` 的同一套
 *     安全规则校验（危险权限 / MAIN world / 注入范围），装不进去就是装不进去；
 *   · 安装目标目录由 `catalogSlug()` 从条目 id **确定性**推导，重复安装 = 覆盖同一个目录，
 *     不会因为点两次装出两份。
 */

/** 单条目录声明（catalog.json 的条目）。 */
export interface BrowserExtensionCatalogEntry {
  /** 稳定 id（小写字母/数字/短横线，3~40），安装目录由它推导 */
  key: string
  /** 扩展本体所在子目录（相对目录根，必须与 key 同规则，拒绝路径穿越） */
  dir: string
  /** 展示名（可与 manifest.name 不同，manifest 为准） */
  name: string
  /** 一句话卖点 */
  summary: string
  /** 详细说明（可选） */
  description?: string
  /** 标签（可选，最多 6 个） */
  tags?: string[]
}

export interface BrowserExtensionCatalogIndex {
  version: 1
  entries: BrowserExtensionCatalogEntry[]
}

/** 安装后的目录 slug：`ext_` + 8 位十六进制（与既有 SLUG_PATTERN 一致）。 */
export function catalogSlug(key: string): string {
  // 简单确定性散列（FNV-1a 32bit）：只用于生成目录名，不做安全用途。
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `ext_${hash.toString(16).padStart(8, '0').slice(0, 8)}`
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/

export type CatalogIndexParse =
  | { ok: true; index: BrowserExtensionCatalogIndex }
  | { ok: false; message: string }

/**
 * 校验目录清单。
 *
 * 注意：这是**随包发**的清单，理论上可信；但目录文件也可能被用户手动替换（它就在安装目录里），
 * 所以路径字段仍然严格校验——`dir: "../../.."` 能把任意目录复制成扩展，必须挡在建任务之前。
 */
export function parseCatalogIndex(raw: unknown): CatalogIndexParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'catalog.json 不是对象' }
  const source = raw as Record<string, unknown>
  if (Number(source.version) !== 1) return { ok: false, message: 'catalog.json 版本不受支持（仅支持 version: 1）' }
  if (!Array.isArray(source.entries)) return { ok: false, message: 'catalog.json 缺少 entries 数组' }
  if (source.entries.length > 100) return { ok: false, message: 'catalog.json 条目过多（上限 100）' }
  const entries: BrowserExtensionCatalogEntry[] = []
  const seen = new Set<string>()
  for (const item of source.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, message: 'catalog.json 条目不是对象' }
    const entry = item as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    const dir = typeof entry.dir === 'string' ? entry.dir.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
    const description = typeof entry.description === 'string' ? entry.description.trim() : ''
    const tagsRaw = entry.tags
    if (!KEY_PATTERN.test(key)) return { ok: false, message: `条目 id 不合法：${key.slice(0, 48) || '(空)'}` }
    if (!KEY_PATTERN.test(dir)) return { ok: false, message: `条目 ${key} 的目录名不合法（只允许小写字母/数字/短横线）` }
    if (!name || name.length > 64) return { ok: false, message: `条目 ${key} 的名称缺失或过长` }
    if (!summary || summary.length > 160) return { ok: false, message: `条目 ${key} 的简介缺失或过长` }
    if (description.length > 2000) return { ok: false, message: `条目 ${key} 的说明过长` }
    const tags = Array.isArray(tagsRaw)
      ? [...new Set(tagsRaw.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))].slice(0, 6)
      : []
    if (seen.has(key)) return { ok: false, message: `条目 id 重复：${key}` }
    seen.add(key)
    entries.push({ key, dir, name, summary, ...(description ? { description } : {}), ...(tags.length ? { tags } : {}) })
  }
  return { ok: true, index: { version: 1, entries } }
}
