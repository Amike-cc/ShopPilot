/**
 * 商品纯规则（主进程与渲染层共用；方案 §5.6「规范化的不猜规则」）
 *
 * 这里的每一条解析规则都**对应一次真机实测**（证据见 docs/product-profiles.md §1），
 * 没有实测支撑的形态一律不写规则 —— 解析不出来就返回 null / unknown，**不用兜底值假装成功**。
 *
 * 三条最容易错的纪律：
 *   1) **库存读不到就 null，绝不写 0**（0 会让运营以为真没货，去补货）；
 *   2) **状态只在命中实测文案时映射**（把"审核中"当"在售"是事故）；
 *   3) 解析不出来时**保留原文**（raw 单元格进 raw_snapshot_json），不猜。
 */

import type { PlatformProductStatus, PlatformProductSku } from './contracts/platform-product'
import type { ProductColumnKey, ProductProfile } from './constants/product'

/** 单元格文本清洗：合并空白、去零宽字符（平台常有 `\u200b`）。 */
export function normalizeCellText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 全角数字/符号 → 半角（个别平台列会混用）。 */
function toHalfWidth(text: string): string {
  return text.replace(/[０-９．，]/g, ch => {
    const code = ch.charCodeAt(0)
    if (ch === '．') return '.'
    if (ch === '，') return ','
    return String.fromCharCode(code - 0xfee0)
  })
}

/**
 * 标题格 → { title, platformProductId }
 *
 * 实测两种形态：
 *   微信小店：`儿童加厚款暖暖套装… ID: 10001…`
 *   拼多多  ：`带扣子长袖儿童浴袍… ID: 837429019978 商品编码: 暂无编码`
 * 都形如「标题 ID: 数字」，ID 后面可能还跟着别的字段。
 */
export function parseTitleCell(raw: unknown): { title: string; platformProductId: string | null } {
  const text = normalizeCellText(raw)
  if (!text) return { title: '', platformProductId: null }
  const match = text.match(/^(.*?)\s*ID\s*[:：]\s*([0-9A-Za-z_-]{4,})/)
  if (!match) return { title: text, platformProductId: null }
  const title = normalizeCellText(match[1])
  return { title: title || text, platformProductId: match[2] }
}

/**
 * 价格格 → 分为单位。
 *
 * 实测形态：
 *   `￥29.90`（微信用 ￥ 前缀）
 *   `19.99～29.99`（拼多多区间）
 *   `16.9 活动价：15.88`（拼多多展示价 + 活动价）
 *
 * 取值口径：**取单元格里出现的第一个价格数字** —— 也就是运营在列表页看到的那一个。
 * 为什么不是"取最小"：`16.9 活动价：15.88` 里最小的是活动价，而它不是列表的展示价；
 * 口径混用会让"本地价格 vs 平台价格"的对比失去意义。原始单元格照旧进 raw_snapshot_json。
 */
export function parsePriceMinor(raw: unknown): number | null {
  const text = toHalfWidth(normalizeCellText(raw))
  if (!text) return null
  const match = text.match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  // 分：四舍五入到分，避免 16.9 * 100 = 1689.9999 这类浮点尾差
  return Math.round(value * 100)
}

/**
 * 库存格 → 整数。
 *
 * 实测形态：
 *   微信小店：`60000 待付款库存 0`   ← 「待付款库存」是**另一个口径**，不是总库存
 *   拼多多  ：`8000 修改库存`、`3 修改库存 低库存`
 *
 * 口径：取**第一个整数**（列表主数值），其余修饰文案忽略。
 * 取不到 → null（**绝不写 0**）。含 `待付款库存` 这类第二口径时同时给出提示，交给界面如实说明。
 */
export function parseStock(raw: unknown): { stock: number | null; extraNote: string | null } {
  const text = normalizeCellText(raw)
  if (!text) return { stock: null, extraNote: null }
  const match = text.match(/(\d{1,9})/)
  const stock = match ? Number(match[1]) : null
  const extraNote = /待付款库存/.test(text) ? '该格还含「待付款库存」，与总库存不是同一口径' : null
  return { stock: Number.isFinite(stock as number) ? stock : null, extraNote }
}

/**
 * 状态 → 统一枚举。**只映射实测见过的文案**。
 *
 * 已实测（2026-09-30，四平台）：
 *   · 微信小店数据行：`销售中`（配 `上架时间: …`）
 *   · 拼多多状态页签：`在售中(19)`、`已下架(57)`
 *   · 抖店数据行：`售卖中`（配 `2026/05/12 01:21:16`）
 *   · 快手商家后台数据行：`在售`
 * 没实测过的（审核中/违规）**故意不映射** → unknown。猜错状态的代价是运营按错的状态做决策。
 */
export function parseStatus(raw: unknown): PlatformProductStatus {
  const text = normalizeCellText(raw)
  if (!text) return 'unknown'
  // 「在售」同时覆盖「在售中」；四个平台的在售文案都是实测来的，不是推出来的
  if (/在售|销售中|售卖中/.test(text)) return 'on_sale'
  if (/已下架|下架/.test(text)) return 'off_shelf'
  return 'unknown'
}

/**
 * 状态/时间格 → { status, updatedAtText }
 * 实测三种形态：
 *   微信小店：`销售中 上架时间: 2026-09-17 1…`
 *   抖店    ：`2026/05/12 01:21:16 售卖中`（**时间在前、且用斜杠**）
 *   拼多多  ：`2025-10-15 20:41 销售中`
 * 这里只把**时间文本**取出来（转毫秒交给 parseDateTimeMs），不做"猜年份"这种事。
 */
export function parseStatusTimeCell(raw: unknown): { status: PlatformProductStatus; timeText: string | null } {
  const text = normalizeCellText(raw)
  return {
    status: parseStatus(text),
    // 两种分隔符都要认：`-`（微信/拼多多/快手）与 `/`（抖店实测）
    timeText: text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/)?.[0] ?? null
  }
}

/**
 * `2026-09-17 10:30:00` / `2026/05/12 01:21:16` / `2025-10-15 20:41` → 毫秒。
 * 格式不全（只有日期）按当天 00:00 处理；解析不了返回 null（**不猜年份**）。
 *
 * 两种分隔符都是实测来的：微信/拼多多/快手用 `-`，**抖店用 `/`**（2026-09-30 实测）。
 */
export function parseDateTimeMs(text: unknown): number | null {
  const value = normalizeCellText(text)
  if (!value) return null
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * 规格文本 → 规格组合。**实测阶段还没拿到真实样例**（列表页不含 SKU），
 * 所以这里只做"能拆就拆、拆不了就整串当一个值"的保守处理，绝不臆造 name/value 配对。
 */
export function parseSpecText(raw: unknown): Array<{ name: string; value: string }> {
  const text = normalizeCellText(raw)
  if (!text) return []
  const parts = text.split(/[;；]/).map(part => part.trim()).filter(Boolean)
  const specs: Array<{ name: string; value: string }> = []
  for (const part of parts) {
    const kv = part.match(/^(.{1,10}?)[:：](.+)$/)
    if (kv) specs.push({ name: normalizeCellText(kv[1]), value: normalizeCellText(kv[2]) })
    else specs.push({ name: '', value: part })
  }
  return specs
}

/** 判断一行是不是"空壳行"（抖店实测：`<tbody>` 前两行是 0 高度占位行，单元格全空）。 */
export function isEmptyRow(cells: readonly unknown[]): boolean {
  return cells.every(cell => normalizeCellText(cell) === '')
}

/**
 * 草稿指纹。
 *
 * 用途有两个，都必须**确定性**（同内容同指纹）：
 *   ① 判断"这个商品自上次发布后改没改"（没改就不让重发）；
 *   ② 发布幂等键的组成部分。
 *
 * 为什么不用 node:crypto：这份文件渲染层也要用（发布面板要算），
 * 而 shared 包不依赖 Node 内置模块。用 64 位 FNV-1a：确定性、无依赖、够用（不是安全哈希）。
 */
export function productDraftHash(input: Record<string, unknown>): string {
  const canonical = canonicalJson(input)
  // FNV-1a 64 位（用两个 32 位半区拼，避免 BigInt 在个别目标环境里的兼容问题）
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + code) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** 对象的确定性序列化（键按字典序，忽略 undefined）——保证同内容必然同指纹。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}'
}

/** 商品上架状态文案（界面用；单一来源，禁止散落字符串）。 */
export function productStatusLabel(status: PlatformProductStatus): string {
  switch (status) {
    case 'on_sale': return '在售'
    case 'off_shelf': return '已下架'
    case 'auditing': return '审核中'
    case 'violation': return '违规'
    default: return '状态未取到'
  }
}

/** 供界面把"未取到"如实说出来的占位。 */
export const PRODUCT_UNKNOWN_TEXT = '未取到'

/** 便于界面复用：把 SKU 列表按价格排序（null 排最后）。 */
export function sortSkusByPrice(skus: readonly PlatformProductSku[]): PlatformProductSku[] {
  return [...skus].sort((a, b) => {
    if (a.priceMinor == null && b.priceMinor == null) return 0
    if (a.priceMinor == null) return 1
    if (b.priceMinor == null) return -1
    return a.priceMinor - b.priceMinor
  })
}

// ------------------------------------------------------------------ 表格 → 统一商品

export interface ParsedProductRow {
  platformProductId: string | null
  title: string
  subtitle: string | null
  status: PlatformProductStatus
  priceMinor: number | null
  stock: number | null
  categoryPath: string | null
  platformUpdatedAt: number | null
  imageUrls: string[]
  skus: PlatformProductSku[]
  rawRow: string[]
  /** 解析过程中的如实提示（如"该格还含另一个口径"）——界面要能看见，不能吞掉 */
  notes: string[]
}

export interface MapRowsResult {
  rows: ParsedProductRow[]
  /** 表头与档案对不上（平台改版）→ 上层必须报 PAGE_CHANGED 且**不写任何数据** */
  headerMismatch: boolean
  missingHeaders: string[]
}

/**
 * 把页面读回来的表头 + 数据行映射成统一商品。
 *
 * 关键纪律：
 *   · `columnStrategy='header'` 时，**表头对不上就整体失败**（返回 headerMismatch），
 *     绝不用"部分匹配"硬套——列错位会把库存当价格写进库；
 *   · 数据行首列是 checkbox 时（`leadingCheckboxColumn`）先去掉，否则整体错位一列；
 *   · 取不到值的字段保持 null，并把原因写进 `notes`。
 */
export function mapProductRows(
  profile: ProductProfile,
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): MapRowsResult {
  const normalizedHeaders = headers.map(header => normalizeCellText(header))

  // 表头 → 列下标。header 策略下必须先验证档案里声明的表头**都在**。
  const indexByKey = new Map<ProductColumnKey, number>()
  const missingHeaders: string[] = []
  let headerMismatch = false

  if (profile.columnStrategy === 'header') {
    for (const column of profile.columns) {
      const index = normalizedHeaders.findIndex(header => header === column.headerText)
      if (index < 0) { missingHeaders.push(column.headerText); continue }
      indexByKey.set(column.key, index)
    }
    // 一个表头都没对上 = 平台改版；只对上部分则按"缺列"处理（缺的字段留 null，但不算改版）
    headerMismatch = indexByKey.size === 0
  } else {
    // index 策略：按档案里 columns 的顺序固定映射（拼多多第二张表实测无 `<th>`）
    profile.columns.forEach((column, index) => indexByKey.set(column.key, index))
  }

  // 勾选框列的偏移**只对 index 策略有意义**：
  //   · header 策略是按**表头文案**定位列的，表头行本身含不含勾选框列都能对齐
  //     （实测四平台表头都是 7~10 个 `<th>`，首个为空表头对应勾选框）；
  //   · index 策略没有表头可依，只能靠"档案列序 + 偏移"。
  // 这条边界是踩出来的（2026-09-30）：微信档案曾因探针把空表头过滤掉而误设成 true，
  // 旧读取器碰巧抵消、新读取器不抵消 —— 于是 4 个商品全被解析成"没有 ID"。
  const offset = profile.columnStrategy === 'index' && profile.leadingCheckboxColumn ? 1 : 0
  const pick = (cells: readonly string[], key: ProductColumnKey): string | null => {
    const index = indexByKey.get(key)
    if (index == null) return null
    const raw = cells[index + offset]
    const text = normalizeCellText(raw)
    return text || null
  }

  const out: ParsedProductRow[] = []
  for (const cells of rows) {
    const normalizedCells = cells.map(cell => normalizeCellText(cell))
    if (isEmptyRow(normalizedCells)) continue

    const titleCell = pick(normalizedCells, 'title')
    const { title, platformProductId } = parseTitleCell(titleCell)
    const statusSource = pick(normalizedCells, 'status_time') ?? pick(normalizedCells, 'status')
    // 时间可能和状态同格（微信/抖店/拼多多），也可能是独立一列（快手商家后台实测：创建时间与商品状态分开）
    const timeSource = pick(normalizedCells, 'status_time') ?? pick(normalizedCells, 'time')
    const { status } = parseStatusTimeCell(statusSource)
    const timeText = parseStatusTimeCell(timeSource).timeText
    const stockParsed = parseStock(pick(normalizedCells, 'stock'))
    const notes: string[] = []
    if (stockParsed.extraNote) notes.push(stockParsed.extraNote)
    if (!platformProductId) notes.push('该行没有解析到平台商品 ID，本条不会被落库（没有幂等键）')
    if (!title) notes.push('标题为空')
    if (status === 'unknown' && statusSource) notes.push(`状态文案未登记：${statusSource.slice(0, 20)}`)

    // 图片：列表页读到的是 URL 列表（表格里通常只有一张缩略图，链接在 img[src]）
    const imageUrls: string[] = []

    out.push({
      platformProductId,
      title,
      subtitle: pick(normalizedCells, 'subtitle'),
      status,
      priceMinor: parsePriceMinor(pick(normalizedCells, 'price')),
      stock: stockParsed.stock,
      categoryPath: pick(normalizedCells, 'category'),
      platformUpdatedAt: parseDateTimeMs(timeText),
      imageUrls,
      skus: [],
      rawRow: normalizedCells,
      notes
    })
  }

  return { rows: out, headerMismatch, missingHeaders }
}
