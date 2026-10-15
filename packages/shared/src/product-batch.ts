import { escapeCsvCell, neutralizeCsvFormula } from './invoice-csv'
import { parseSpecText } from './product-rules'

/**
 * 商品批量操作与 CSV 导入导出的**纯函数层**（v4 重设计 §3.5 / §4.6 R3）。
 *
 * 为什么放 shared：这些规则要被单测钉死（product-batch-price / product-batch-tags-archive /
 * product-csv 三份测试清单），也要被主进程与渲染层共用（预览 diff 在主进程算，界面回显）。
 * 任何"猜测业务"的逻辑都不该出现在这一层——解析不出就如实返回 null / 冲突。
 */

// ---------------------------------------------------------------- 批量上限（§3.5 表格）

export const PRODUCT_BATCH_LIMITS = {
  /** 单次批量改价最多商品数 */
  price: 200,
  /** 单次批量加/删标签最多商品数 */
  tags: 500,
  /** 单次批量归档/取消归档最多商品数 */
  archive: 500,
  /** 单次批量删除最多商品数（软删，同 §3.4） */
  delete: 100,
  /** 多选跨页累计上限 */
  select: 500
} as const

export type BatchOperation = 'price' | 'tags.add' | 'tags.remove' | 'archive' | 'unarchive' | 'delete'

export interface BatchPriceParams {
  mode: 'percent' | 'fixed'
  /** percent: ±百分比；fixed: ±元（转分前由调用方保证类型） */
  value: number
  /** 最低价保护（分），默认 1 分 */
  floorMinor?: number
}

/**
 * 单个变体的批量改价。**null 进 null 出**：价格未取到的变体跳过并计数（§3.5 + 附录 A），
 * 绝不当 0。四舍五入用整数分上的 Math.round（避免浮点二义性）。
 */
export function applyBatchPrice(
  oldMinor: number | null,
  params: BatchPriceParams
): number | null {
  if (oldMinor == null || !Number.isFinite(oldMinor)) return null
  const floor = Math.max(1, Math.floor(params.floorMinor ?? 1))
  const raw = params.mode === 'percent'
    ? Math.round(oldMinor * (1 + params.value / 100))
    : Math.round(oldMinor + params.value * 100)
  return Math.max(raw, floor)
}

/** 批量改价后的展示 diff（预览用）：元字符串，如实标注保护触发。 */
export function describeBatchPrice(oldMinor: number, newMinor: number, params: BatchPriceParams): string {
  const floor = Math.max(1, Math.floor(params.floorMinor ?? 1))
  const unprotected = params.mode === 'percent'
    ? Math.round(oldMinor * (1 + params.value / 100))
    : Math.round(oldMinor + params.value * 100)
  const guarded = unprotected < floor
  const fmt = (minor: number) => `¥${(minor / 100).toFixed(2)}`
  const scope = params.mode === 'percent' ? `${params.value > 0 ? '+' : ''}${params.value}%` : `${params.value > 0 ? '+' : ''}${params.value}元`
  return `${fmt(oldMinor)} → ${fmt(newMinor)}（${scope}${guarded ? '，最低价保护' : ''}）`
}

// ---------------------------------------------------------------- 批量标签（去重合并不改其他标签）

export function mergeProductTags(existing: string[], toAdd: string[], max = 30): { tags: string[]; added: string[] } {
  const set = [...existing]
  const added: string[] = []
  for (const tag of toAdd) {
    const value = String(tag ?? '').trim()
    if (!value || set.includes(value)) continue
    if (set.length >= max) break
    set.push(value)
    added.push(value)
  }
  return { tags: set, added }
}

export function removeProductTags(existing: string[], toRemove: string[]): { tags: string[]; removed: string[] } {
  const drop = new Set(toRemove.map(tag => String(tag ?? '').trim()).filter(Boolean))
  const tags = existing.filter(tag => !drop.has(tag))
  return { tags, removed: [...drop].filter(tag => existing.includes(tag)) }
}

// ---------------------------------------------------------------- CSV 导出（§4.6）

export const PRODUCT_CSV_HEADERS = ['标题', '副标题', '品牌', '本地分类', '标签', '状态', '规格', '价格', '库存', 'SKU码', '条码', '挂载平台', '更新时间'] as const

export interface ProductCsvSource {
  title: string
  subtitle: string | null
  brand: string | null
  localCategory: string | null
  tags: string[]
  status: string
  variants: Array<{ spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null; skuCode?: string | null; barcode?: string | null }>
  linkedPlatforms: string[]
  updatedAt: number
}

/** 变体聚合（与列表口径一致）：规格文本 / 价格区间 / 库存合计 / SKU 码 / 条码。 */
export function summarizeVariants(variants: ProductCsvSource['variants']): { specText: string; priceText: string; stockText: string; skuText: string; barcodeText: string } {
  if (!variants.length) return { specText: '', priceText: '', stockText: '', skuText: '', barcodeText: '' }
  const specText = variants
    .map(variant => variant.spec.map(part => (part.name ? `${part.name}:${part.value}` : part.value)).join(';'))
    .filter(Boolean).join(' | ')
  const prices = variants.map(variant => variant.priceMinor).filter((price): price is number => price != null)
  const priceText = prices.length
    ? (prices.length === 1 && variants.length === 1 ? `¥${(prices[0] / 100).toFixed(2)}` : `¥${(Math.min(...prices) / 100).toFixed(2)}–¥${(Math.max(...prices) / 100).toFixed(2)}`)
    : ''
  const stocks = variants.map(variant => variant.stock).filter((stock): stock is number => stock != null)
  const stockText = stocks.length ? String(stocks.reduce((sum, stock) => sum + stock, 0)) : ''
  const skuText = [...new Set(variants.map(variant => variant.skuCode).filter((sku): sku is string => !!sku))].join('|')
  const barcodeText = [...new Set(variants.map(variant => variant.barcode).filter((barcode): barcode is string => !!barcode))].join('|')
  return { specText, priceText, stockText, skuText, barcodeText }
}

/** 商品 → CSV 行（顺序 = PRODUCT_CSV_HEADERS；转义与公式注入防护走发票中心同款 escapeCsvCell）。 */
export function productCsvRows(products: readonly ProductCsvSource[]): string[][] {
  return products.map(product => {
    const summary = summarizeVariants(product.variants)
    return [
      product.title,
      product.subtitle ?? '',
      product.brand ?? '',
      product.localCategory ?? '',
      product.tags.join('|'),
      product.status,
      summary.specText,
      summary.priceText,
      summary.stockText,
      summary.skuText,
      summary.barcodeText,
      product.linkedPlatforms.join('|'),
      new Date(product.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
    ]
  })
}

export function buildProductCsv(rows: string[][]): string {
  const headerLine = PRODUCT_CSV_HEADERS.map(header => escapeCsvCell(header)).join(',')
  const lines = rows.map(row => row.map(cell => escapeCsvCell(cell)).join(','))
  // UTF-8 BOM：Excel 打开中文不乱码（发票中心实测过的坑）
  return '\uFEFF' + [headerLine, ...lines].join('\r\n')
}

// ---------------------------------------------------------------- CSV 解析（RFC4180 子集：引号/转义引号/CR-LF）

/** 解析 CSV 文本为行数组。带 BOM 剥离；引号内逗号/换行/双引号按规则处理；不抛异常（坏行如实保留）。 */
export function parseCsvRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let index = 0; index < clean.length; index += 1) {
    const ch = clean[index]
    if (inQuotes) {
      if (ch === '"') {
        if (clean[index + 1] === '"') { cell += '"'; index += 1 }
        else inQuotes = false
      } else cell += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(cell); cell = ''; continue }
    if (ch === '\r') { row.push(cell); rows.push(row); row = []; cell = ''; if (clean[index + 1] === '\n') index += 1; continue }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += ch
  }
  // 最后一行（无换行结尾也算一行；纯空行丢弃）
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

// ---------------------------------------------------------------- CSV 导入规划（匹配键：SKU 码优先、标题精确次之；字段级更新）

export interface ProductImportRow {
  rowNumber: number
  title: string
  subtitle: string | null
  brand: string | null
  localCategory: string | null
  tags: string[]
  skuCode: string | null
  barcode: string | null
  priceMinor: number | null
  stock: number | null
}

export interface ProductMatchSummary {
  id: string
  title: string
  status: string
  subtitle: string | null
  brand: string | null
  localCategory: string | null
  tags: string[]
  variants: Array<{ skuCode: string | null; priceMinor: number | null; stock: number | null }>
}

export interface ProductImportPlan {
  creates: Array<{ rowNumber: number; title: string }>
  updates: Array<{
    rowNumber: number
    productId: string
    title: string
    /** 字段级变更（只含有值的列） */
    changes: Array<{ field: string; before: string; after: string }>
  }>
  /** 无法落地的行 + 如实原因（冲突 / 缺匹配 / 多规格缺 SKU） */
  conflicts: Array<{ rowNumber: number; title: string; reason: string }>
}

const toMinor = (text: string | null): number | null => {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const value = Number(trimmed.replace(/[¥￥,]/g, ''))
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

/** 把 CSV 数据行（已解析）映射成导入行；列缺失给 null。 */
export function mapCsvRowsToImportRows(rows: string[][]): ProductImportRow[] {
  // 第一行是表头（buildProductCsv 生成；手工表头也按列名匹配，宽容列序）
  const dataRows = rows.slice(1)
  return dataRows.map((cells, index) => {
    const get = (name: string): string => {
      const column = PRODUCT_CSV_HEADERS.indexOf(name as (typeof PRODUCT_CSV_HEADERS)[number])
      return column >= 0 ? String(cells[column] ?? '').trim() : ''
    }
    const priceText = get('价格')
    return {
      rowNumber: index + 2, // CSV 行号（含表头，从 2 起）
      title: get('标题'),
      subtitle: get('副标题') || null,
      brand: get('品牌') || null,
      localCategory: get('本地分类') || null,
      tags: get('标签') ? get('标签').split('|').map(tag => tag.trim()).filter(Boolean) : [],
      skuCode: get('SKU码') || null,
      barcode: get('条码') || null,
      priceMinor: toMinor(priceText),
      stock: get('库存') ? Number(get('库存')) || null : null
    }
  }).filter(row => row.title || row.skuCode)
}

/**
 * 导入规划：对每一行给出「新增 / 更新（字段级 diff）/ 冲突（如实原因）」。
 * 匹配：SKU 码优先（唯一命中某个变体才算），标题精确次之（唯一命中才算，重名 = 冲突）。
 * 多规格商品改价必须带 SKU 码——带 SKU 改对应变体；不带就如实报冲突，绝不猜改哪一行。
 */
export function planProductCsvImport(
  rows: ProductImportRow[],
  matches: Array<ProductMatchSummary>
): ProductImportPlan {
  const plan: ProductImportPlan = { creates: [], updates: [], conflicts: [] }
  const titleGroups = new Map<string, ProductMatchSummary[]>()
  for (const product of matches) {
    const list = titleGroups.get(product.title) ?? []
    list.push(product)
    titleGroups.set(product.title, list)
  }
  const skuIndex = new Map<string, { product: ProductMatchSummary; variantIndex: number }>()
  for (const product of matches) {
    product.variants.forEach((variant, variantIndex) => {
      if (variant.skuCode) skuIndex.set(variant.skuCode, { product, variantIndex })
    })
  }

  for (const row of rows) {
    if (!row.title && !row.skuCode) continue
    let target: { product: ProductMatchSummary; variantIndex: number | null } | null = null
    if (row.skuCode) {
      const hit = skuIndex.get(row.skuCode)
      if (hit) target = { product: hit.product, variantIndex: hit.variantIndex }
      else if (row.title && titleGroups.get(row.title)?.length === 1) {
        target = { product: titleGroups.get(row.title)![0], variantIndex: null }
      } else if (row.title) {
        plan.conflicts.push({ rowNumber: row.rowNumber, title: row.title, reason: 'SKU 码未匹配到变体，且标题无法唯一定位' })
        continue
      } else {
        plan.conflicts.push({ rowNumber: row.rowNumber, title: '(无标题)', reason: 'SKU 码未匹配到任何变体' })
        continue
      }
    } else {
      const group = titleGroups.get(row.title)
      if (!group) { plan.creates.push({ rowNumber: row.rowNumber, title: row.title }); continue }
      if (group.length > 1) { plan.conflicts.push({ rowNumber: row.rowNumber, title: row.title, reason: '标题命中多个商品（重名），需提供 SKU 码区分' }); continue }
      target = { product: group[0], variantIndex: null }
    }

    const product = target.product
    const changes: ProductImportPlan['updates'][number]['changes'] = []
    // 字段级：只写有值的列；before 取现有值，没有变化不进 diff
    if (row.subtitle != null && (product.subtitle ?? '') !== row.subtitle) {
      changes.push({ field: '副标题', before: product.subtitle ?? '', after: row.subtitle })
    }
    if (row.brand != null && (product.brand ?? '') !== row.brand) {
      changes.push({ field: '品牌', before: product.brand ?? '', after: row.brand })
    }
    if (row.localCategory != null && (product.localCategory ?? '') !== row.localCategory) {
      changes.push({ field: '本地分类', before: product.localCategory ?? '', after: row.localCategory })
    }
    if (row.tags.length && JSON.stringify(product.tags) !== JSON.stringify(row.tags)) {
      changes.push({ field: '标签', before: product.tags.join('|'), after: row.tags.join('|') })
    }
    // 价格 / 库存：带 SKU → 改对应变体；命中商品只有 1 个变体 → 直接改；多规格没带 SKU → 如实冲突
    if (row.priceMinor != null || row.stock != null) {
      if (target.variantIndex != null) {
        const variant = product.variants[target.variantIndex]
        if (row.priceMinor != null) changes.push({ field: `价格(${row.skuCode})`, before: variant.priceMinor == null ? '—' : `¥${(variant.priceMinor / 100).toFixed(2)}`, after: `¥${(row.priceMinor / 100).toFixed(2)}` })
        if (row.stock != null) changes.push({ field: `库存(${row.skuCode})`, before: variant.stock == null ? '—' : String(variant.stock), after: String(row.stock) })
      } else if (product.variants.length === 1) {
        const variant = product.variants[0]
        if (row.priceMinor != null) changes.push({ field: '价格', before: variant.priceMinor == null ? '—' : `¥${(variant.priceMinor / 100).toFixed(2)}`, after: `¥${(row.priceMinor / 100).toFixed(2)}` })
        if (row.stock != null) changes.push({ field: '库存', before: variant.stock == null ? '—' : String(variant.stock), after: String(row.stock) })
      } else {
        plan.conflicts.push({ rowNumber: row.rowNumber, title: product.title, reason: '多规格商品改价/库存必须提供 SKU 码' })
        continue
      }
    }
    if (!changes.length) {
      plan.conflicts.push({ rowNumber: row.rowNumber, title: product.title, reason: '没有可应用的变更（有值的列与现状一致）' })
      continue
    }
    plan.updates.push({ rowNumber: row.rowNumber, productId: product.id, title: product.title, changes })
  }
  return plan
}

/** 规格文本 → 变体（导入"新增"用）：与解析规则同源（不猜），解析不出整串保留为单值。 */
export function importRowToVariants(row: ProductImportRow): ProductCsvSource['variants'] {
  if (row.priceMinor == null && row.stock == null && !row.skuCode) return []
  return [{
    spec: [],
    priceMinor: row.priceMinor,
    stock: row.stock,
    skuCode: row.skuCode,
    barcode: row.barcode
  }]
}

export { parseSpecText, neutralizeCsvFormula }
