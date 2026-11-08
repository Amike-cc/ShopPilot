/**
 * 会话包里的「站点本地存储」口径（纯函数，主进程与单测共用）。
 *
 * 为什么需要单独一层：localStorage 是自由文本，单个站点可以塞几 MB；导出包要加密、
 * 要跨机传输，必须有明确上限，超限的**如实计数**（skipped）而不是静默丢或把包撑爆。
 *
 * 边界（如实声明）：只覆盖 localStorage，不含 IndexedDB / CacheStorage / Service Worker。
 * 不做"读 LevelDB 文件"那一套——格式随 Chromium 版本变，跨机恢复一旦错就是登录态静默损坏。
 */

export interface SessionStorageItem {
  name: string
  value: string
}

export interface SessionStorageEntry {
  /** 规范化后的 origin（scheme://host[:port]），不含路径与凭据 */
  origin: string
  items: SessionStorageItem[]
}

/** 上限按"字符数"计（UTF-16 码元），是体积的保守近似：中文按 3 字节存，字符数只会更小。 */
export const SESSION_STORAGE_LIMITS = {
  /** 最多采集几个站点：够覆盖平台后台 + 其登录/网关域，不会无限逛 */
  maxOrigins: 8,
  /** 单站点最多保留多少条键值 */
  maxItemsPerOrigin: 400,
  /** 单个值的字符上限（超出整条丢弃并计入 skipped） */
  maxValueChars: 128 * 1024,
  /** 单站点所有值合计字符上限 */
  maxOriginChars: 512 * 1024,
  /** 整包合计字符上限 */
  maxTotalChars: 3 * 1024 * 1024
} as const

/**
 * 规范化 origin：只接受 http/https、拒绝带凭据的 URL、丢掉路径与查询。
 * 非 http(s)（file/data/javascript/about）一律返回 null——那些 origin 的 localStorage
 * 既不该导出，也没法在目标机上恢复。
 */
export function normalizeStorageOrigin(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

function sanitizeItems(input: unknown): { items: SessionStorageItem[]; skipped: number; chars: number } {
  if (!input) return { items: [], skipped: 0, chars: 0 }

  // 兼容两种形状：主进程采集出来的是 [name,value][]，手工/历史数据可能是对象映射
  const pairs: Array<[string, string]> = []
  if (Array.isArray(input)) {
    for (const row of input) {
      if (Array.isArray(row) && row.length >= 2) pairs.push([String(row[0] ?? ''), String(row[1] ?? '')])
      else if (row && typeof row === 'object' && 'name' in row) {
        const record = row as { name?: unknown; value?: unknown }
        pairs.push([String(record.name ?? ''), String(record.value ?? '')])
      }
    }
  } else if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      pairs.push([name, String(value ?? '')])
    }
  }

  const items: SessionStorageItem[] = []
  let skipped = 0
  let chars = 0
  const seen = new Set<string>()
  for (const [rawName, rawValue] of pairs) {
    const name = rawName
    if (!name || seen.has(name)) { skipped++; continue }
    if (rawValue.length > SESSION_STORAGE_LIMITS.maxValueChars) { skipped++; continue }
    if (items.length >= SESSION_STORAGE_LIMITS.maxItemsPerOrigin) { skipped++; continue }
    const cost = name.length + rawValue.length
    if (chars + cost > SESSION_STORAGE_LIMITS.maxOriginChars) { skipped++; continue }
    seen.add(name)
    items.push({ name, value: rawValue })
    chars += cost
  }
  return { items, skipped, chars }
}

/**
 * 归一化 + 限额。返回的是**可以进包**的数据与如实统计：
 *   · `entries`：按输入顺序保留、origin 去重后的结果；
 *   · `items` / `chars`：实际保留量；
 *   · `skippedItems`：因为单值过大 / 单站超限 / 总量超限被丢弃的键值条数；
 *   · `skippedOrigins`：因为超过站点数上限或 origin 非法被整站丢弃的数量。
 * 两类跳过分开计数——把"少了 3 个站点"和"少了一个大 key"混成一个数字，用户没法判断影响。
 */
export function sanitizeStorageEntries(input: unknown): {
  entries: SessionStorageEntry[]
  items: number
  skippedItems: number
  skippedOrigins: number
  chars: number
} {
  const entries: SessionStorageEntry[] = []
  const seenOrigins = new Set<string>()
  let items = 0
  let skippedItems = 0
  let skippedOrigins = 0
  let chars = 0

  const rows = Array.isArray(input) ? input : []
  for (const row of rows) {
    if (entries.length >= SESSION_STORAGE_LIMITS.maxOrigins) {
      skippedOrigins++
      continue
    }
    const record = (row && typeof row === 'object') ? row as { origin?: unknown; items?: unknown } : null
    const origin = normalizeStorageOrigin(record?.origin)
    if (!origin) { skippedOrigins++; continue }
    if (seenOrigins.has(origin)) continue

    const clean = sanitizeItems(record?.items)
    const budgetLeft = SESSION_STORAGE_LIMITS.maxTotalChars - chars
    if (budgetLeft <= 0) {
      skippedItems += clean.items.length + clean.skipped
      continue
    }

    const kept: SessionStorageItem[] = []
    let keptChars = 0
    let localSkipped = clean.skipped
    for (const item of clean.items) {
      const cost = item.name.length + item.value.length
      if (keptChars + cost > budgetLeft) { localSkipped++; continue }
      kept.push(item)
      keptChars += cost
    }

    seenOrigins.add(origin)
    if (!kept.length) { skippedItems += localSkipped; continue }
    entries.push({ origin, items: kept })
    items += kept.length
    chars += keptChars
    skippedItems += localSkipped
  }

  return { entries, items, skippedItems, skippedOrigins, chars }
}

/**
 * 导出候选 origin：店铺地址 + 平台入口 + 与店铺同域的 Cookie 主机（去重、限量）。
 *
 * 为什么只收「与后台同后缀」的 Cookie 主机：`jinritemai.com` 之于 `fxg.jinritemai.com`
 * 是同一平台的登录域，值得读；而一个与店铺无关的第三方 CDN 域名不该被我们悄悄导航过去。
 */
export function candidateStorageOrigins(input: {
  adminUrl: string | null | undefined
  routeUrls: Array<string | null | undefined>
  cookieDomains: string[]
  max?: number
}): string[] {
  const out: string[] = []
  const push = (url: string | null | undefined) => {
    const origin = normalizeStorageOrigin(url)
    if (origin && !out.includes(origin)) out.push(origin)
  }
  push(input.adminUrl)
  for (const url of input.routeUrls) push(url)

  const adminHost = (() => {
    try { return new URL(String(input.adminUrl || '')).hostname.toLowerCase() } catch { return '' }
  })()
  if (adminHost) {
    for (const raw of input.cookieDomains) {
      const host = String(raw || '').replace(/^\./, '').toLowerCase()
      if (!host || !adminHost.endsWith(host)) continue
      push(`https://${host}`)
    }
  }
  const limit = Math.max(1, Number(input.max) || SESSION_STORAGE_LIMITS.maxOrigins)
  return out.slice(0, limit)
}
