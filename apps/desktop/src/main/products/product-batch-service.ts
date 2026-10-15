import {
  PRODUCT_BATCH_LIMITS,
  applyBatchPrice,
  describeBatchPrice,
  mapCsvRowsToImportRows,
  mergeProductTags,
  parseCsvRows,
  planProductCsvImport,
  productCsvRows,
  removeProductTags,
  type BatchOperation,
  type BatchPriceParams,
  type ProductMatchSummary
} from '@shared/product-batch'
import type { LocalProductDraft } from '@shared/product-draft'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'
import { ProductLibraryService } from './product-library-service'

/**
 * 商品批量操作与 CSV 导入导出（v4 重设计 §3.5 / §3.6 / §4.6 R3）。
 *
 * 通用协议：预览（影响面 + 样例 diff + 跳过项）→ 确认执行 → 回执（成功/跳过/失败明细）→ 审计只记计数。
 * 所有"写"都经由 ProductLibraryService（save/setArchived/softDelete/createFromDraft）——
 * 指纹重算与状态重算永远走单点，批量绝不绕过。
 */

export interface BatchSkipped { id: string; title: string; reason: string }
export interface BatchSample { id: string; title: string; detail: string }
export interface BatchPreview {
  operation: BatchOperation
  affected: number
  skipped: BatchSkipped[]
  sample: BatchSample[]
}
export interface BatchOutcome {
  succeeded: number
  skipped: BatchSkipped[]
  failed: Array<{ id: string; title: string; message: string }>
}

const LIMIT_BY_OP: Record<BatchOperation, number> = {
  price: PRODUCT_BATCH_LIMITS.price,
  'tags.add': PRODUCT_BATCH_LIMITS.tags,
  'tags.remove': PRODUCT_BATCH_LIMITS.tags,
  archive: PRODUCT_BATCH_LIMITS.archive,
  unarchive: PRODUCT_BATCH_LIMITS.archive,
  delete: PRODUCT_BATCH_LIMITS.delete
}

export interface BatchParams {
  mode?: 'percent' | 'fixed'
  value?: number
  floorMinor?: number
  tags?: string[]
}

export class ProductBatchService {
  constructor(
    private readonly repository: ProductRepository,
    private readonly library: ProductLibraryService
  ) {}

  /** CSV 导入规划用的轻量全量清单（匹配键：SKU 码 / 标题）。 */
  listMatches(): ProductMatchSummary[] {
    const rows = this.repository.listStatusCandidates() // 全部未删商品 id
    const matches: ProductMatchSummary[] = []
    for (const { id } of rows) {
      const product = this.repository.getProduct(id)
      if (!product) continue
      matches.push({
        id: product.id,
        title: product.draft.title,
        status: product.status,
        subtitle: product.draft.subtitle ?? null,
        brand: product.draft.brand ?? null,
        localCategory: product.draft.localCategory ?? null,
        tags: [...(product.draft.tags ?? [])],
        variants: product.draft.variants.map(variant => ({
          skuCode: variant.skuCode ?? null,
          priceMinor: variant.priceMinor,
          stock: variant.stock
        }))
      })
    }
    return matches
  }

  // ---------------------------------------------------------------- 预览

  preview(input: { operation: BatchOperation; productIds: string[]; params?: BatchParams }): BatchPreview {
    this.assertLimit(input.operation, input.productIds.length)
    const preview: BatchPreview = { operation: input.operation, affected: 0, skipped: [], sample: [] }
    if (input.operation === 'price') {
      const params = this.priceParams(input.params)
      for (const productId of input.productIds) {
        const product = this.repository.getProduct(productId)
        if (!product) { preview.skipped.push({ id: productId, title: '（不存在）', reason: '商品不存在' }); continue }
        let changed = 0
        let nullCount = 0
        let firstDiff: string | null = null
        for (const variant of product.draft.variants) {
          const next = applyBatchPrice(variant.priceMinor, params)
          if (next == null) { nullCount += 1; continue }
          if (next !== variant.priceMinor) {
            changed += 1
            if (!firstDiff && variant.priceMinor != null) firstDiff = describeBatchPrice(variant.priceMinor, next, params)
          }
        }
        if (!changed) {
          preview.skipped.push({ id: productId, title: product.draft.title, reason: nullCount ? `价格未取到（${nullCount} 个变体），无可调整项` : '价格无变化' })
          continue
        }
        preview.affected += 1
        if (preview.sample.length < 5) preview.sample.push({ id: productId, title: product.draft.title, detail: firstDiff ?? '价格有更新' })
      }
      return preview
    }
    if (input.operation === 'tags.add' || input.operation === 'tags.remove') {
      const tags = (input.params?.tags ?? []).map(tag => String(tag ?? '').trim()).filter(Boolean)
      if (!tags.length) throw new Error('BATCH_TAGS_EMPTY')
      for (const productId of input.productIds) {
        const product = this.repository.getProduct(productId)
        if (!product) { preview.skipped.push({ id: productId, title: '（不存在）', reason: '商品不存在' }); continue }
        const delta = input.operation === 'tags.add'
          ? mergeProductTags([...(product.draft.tags ?? [])], tags).added.length
          : removeProductTags([...(product.draft.tags ?? [])], tags).removed.length
        if (!delta) { preview.skipped.push({ id: productId, title: product.draft.title, reason: '标签无变化' }); continue }
        preview.affected += 1
        if (preview.sample.length < 5) preview.sample.push({ id: productId, title: product.draft.title, detail: `${input.operation === 'tags.add' ? '加' : '删'}「${tags.join('、')}」` })
      }
      return preview
    }
    if (input.operation === 'archive' || input.operation === 'unarchive' || input.operation === 'delete') {
      for (const productId of input.productIds) {
        const product = this.repository.getProduct(productId)
        if (!product) { preview.skipped.push({ id: productId, title: '（不存在）', reason: '商品不存在' }); continue }
        if (input.operation === 'archive' && product.status === 'archived') {
          preview.skipped.push({ id: productId, title: product.draft.title, reason: '已是归档' }); continue
        }
        if (input.operation === 'unarchive' && product.status !== 'archived') {
          preview.skipped.push({ id: productId, title: product.draft.title, reason: '不是归档态' }); continue
        }
        preview.affected += 1
        if (preview.sample.length < 5) {
          preview.sample.push({ id: productId, title: product.draft.title, detail: input.operation === 'delete' ? '移入回收站（可恢复）' : input.operation === 'archive' ? '转只读' : '按内容重算状态' })
        }
      }
      return preview
    }
    throw new Error('BATCH_UNKNOWN_OPERATION')
  }

  // ---------------------------------------------------------------- 执行

  async execute(input: { operation: BatchOperation; productIds: string[]; params?: BatchParams }): Promise<BatchOutcome> {
    this.assertLimit(input.operation, input.productIds.length)
    const outcome: BatchOutcome = { succeeded: 0, skipped: [], failed: [] }
    for (const productId of input.productIds) {
      const title = this.repository.getProduct(productId)?.draft.title ?? '（不存在）'
      try {
        const done = await this.executeOne(input.operation, productId, input.params ?? {})
        if (done) outcome.succeeded += 1
        else outcome.skipped.push({ id: productId, title, reason: '无可变更项' })
      } catch (error) {
        outcome.failed.push({ id: productId, title, message: String((error as Error)?.message || error).slice(0, 160) })
      }
    }
    // 审计只记计数（§3.5 通用协议）：明细留在回执里给界面，日志不留业务数据
    logMain('info', `[product-batch] ${input.operation} 商品=${input.productIds.length} 成功=${outcome.succeeded} 跳过=${outcome.skipped.length} 失败=${outcome.failed.length}`)
    return outcome
  }

  private async executeOne(operation: BatchOperation, productId: string, params: BatchParams): Promise<boolean> {
    if (operation === 'archive' || operation === 'unarchive') {
      const product = this.repository.getProduct(productId)
      if (!product) return false
      if (operation === 'archive' && product.status === 'archived') return false
      if (operation === 'unarchive' && product.status !== 'archived') return false
      this.library.setArchived({ productId, archived: operation === 'archive' })
      return true
    }
    if (operation === 'delete') {
      const product = this.repository.getProduct(productId)
      if (!product) return false
      this.repository.softDeleteProduct(productId)
      return true
    }
    const product = this.repository.getProduct(productId)
    if (!product) return false
    const draft: LocalProductDraft = { ...product.draft, variants: product.draft.variants.map(variant => ({ ...variant })), tags: [...(product.draft.tags ?? [])], media: product.draft.media.map(item => ({ ...item })) }
    if (operation === 'price') {
      const priceParams = this.priceParams(params)
      let changed = false
      for (const variant of draft.variants) {
        const next = applyBatchPrice(variant.priceMinor, priceParams)
        if (next == null || next === variant.priceMinor) continue
        variant.priceMinor = next
        changed = true
      }
      if (!changed) return false
      this.library.save({ productId, draft })
      return true
    }
    if (operation === 'tags.add' || operation === 'tags.remove') {
      const tags = (params.tags ?? []).map(tag => String(tag ?? '').trim()).filter(Boolean)
      if (!tags.length) throw new Error('BATCH_TAGS_EMPTY')
      const result = operation === 'tags.add'
        ? mergeProductTags(draft.tags ?? [], tags)
        : removeProductTags(draft.tags ?? [], tags)
      if (JSON.stringify(result.tags) === JSON.stringify(draft.tags ?? [])) return false
      draft.tags = result.tags
      this.library.save({ productId, draft })
      return true
    }
    throw new Error('BATCH_UNKNOWN_OPERATION')
  }

  private priceParams(params?: BatchParams): BatchPriceParams {
    const mode = params?.mode === 'fixed' ? 'fixed' : 'percent'
    const value = Number(params?.value)
    if (!Number.isFinite(value)) throw new Error('BATCH_PRICE_VALUE_INVALID')
    return { mode, value, floorMinor: params?.floorMinor }
  }

  private assertLimit(operation: BatchOperation, count: number): void {
    const limit = LIMIT_BY_OP[operation]
    if (count > limit) throw new Error(`BATCH_LIMIT_EXCEEDED: ${operation} 单次最多 ${limit} 个商品（当前 ${count}）`)
    if (!count) throw new Error('BATCH_EMPTY_SELECTION')
  }

  // ---------------------------------------------------------------- CSV 导出（§4.6）

  /**
   * 导出：mode=selected 用 productIds；mode=filtered 复用列表查询（当前筛选全量，上限 5000）。
   * 返回数据行（主进程不落盘——保存对话框与写盘在 IPC 层，见 product-handlers）。
   */
  exportRows(input: { mode: 'selected' | 'filtered'; productIds?: string[]; query?: Record<string, unknown> }): string[][] {
    const products: Array<Parameters<typeof productCsvRows>[0][number]> = []
    const collect = (productId: string) => {
      const product = this.repository.getProduct(productId)
      if (!product || product.status === undefined) return
      products.push({
        title: product.draft.title,
        subtitle: product.draft.subtitle ?? null,
        brand: product.draft.brand ?? null,
        localCategory: product.draft.localCategory ?? null,
        tags: [...(product.draft.tags ?? [])],
        status: product.status,
        variants: product.draft.variants.map(variant => ({
          spec: variant.spec,
          priceMinor: variant.priceMinor,
          stock: variant.stock,
          skuCode: variant.skuCode ?? null,
          barcode: (variant as { barcode?: string | null }).barcode ?? null
        })),
        linkedPlatforms: this.repository.platformsForProduct(productId),
        updatedAt: product.updatedAt
      })
    }
    if (input.mode === 'selected') {
      for (const id of input.productIds ?? []) collect(id)
    } else {
      const query = input.query ?? {}
      const listed = this.repository.listProducts({
        keyword: typeof query.keyword === 'string' ? query.keyword : undefined,
        status: Array.isArray(query.status) ? (query.status as string[]) : undefined,
        linked: typeof query.linked === 'string' ? (query.linked as 'any' | 'linked' | 'unlinked') : undefined,
        platform: typeof query.platform === 'string' ? query.platform : undefined,
        sort: typeof query.sort === 'string' ? (query.sort as 'updated' | 'title' | 'created' | 'priceMin' | 'stockTotal') : undefined,
        order: query.order === 'asc' ? 'asc' : 'desc',
        limit: 5000,
        offset: 0
      })
      for (const row of listed.rows) collect(row.id)
    }
    return productCsvRows(products)
  }

  // ---------------------------------------------------------------- CSV 导入（预览 diff + 单事务落库）

  importPreview(csvText: string) {
    const rows = mapCsvRowsToImportRows(parseCsvRows(String(csvText ?? '')))
    if (!rows.length) throw new Error('IMPORT_EMPTY')
    return planProductCsvImport(rows, this.listMatches())
  }

  importExecute(csvText: string): { created: number; updated: number; conflicts: Array<{ rowNumber: number; title: string; reason: string }> } {
    const rows = mapCsvRowsToImportRows(parseCsvRows(String(csvText ?? '')))
    const plan = planProductCsvImport(rows, this.listMatches())
    let created = 0
    let updated = 0
    this.repository.transaction(() => {
      for (const item of plan.creates) {
        const row = rows.find(candidate => candidate.rowNumber === item.rowNumber)
        if (!row) continue
        this.library.createFromDraft({
          title: row.title || '未命名商品',
          subtitle: row.subtitle,
          description: null,
          brand: row.brand,
          localCategory: row.localCategory,
          tags: row.tags,
          variants: row.priceMinor != null || row.stock != null || row.skuCode
            ? [{ spec: [], priceMinor: row.priceMinor, stock: row.stock, skuCode: row.skuCode, barcode: row.barcode }]
            : [],
          media: []
        })
        created += 1
      }
      for (const item of plan.updates) {
        const row = rows.find(candidate => candidate.rowNumber === item.rowNumber)
        const product = row ? this.repository.getProduct(item.productId) : null
        if (!row || !product) continue
        const draft: LocalProductDraft = { ...product.draft, variants: product.draft.variants.map(variant => ({ ...variant })), tags: [...(product.draft.tags ?? [])], media: product.draft.media.map(item => ({ ...item })) }
        if (row.subtitle != null) draft.subtitle = row.subtitle
        if (row.brand != null) draft.brand = row.brand
        if (row.localCategory != null) draft.localCategory = row.localCategory
        if (row.tags.length) draft.tags = row.tags
        const skuVariant = row.skuCode ? draft.variants.find(variant => variant.skuCode === row.skuCode) : null
        if (skuVariant) {
          if (row.priceMinor != null) skuVariant.priceMinor = row.priceMinor
          if (row.stock != null) skuVariant.stock = row.stock
          if (row.barcode) skuVariant.barcode = row.barcode
        } else if (draft.variants.length === 1) {
          if (row.priceMinor != null) draft.variants[0].priceMinor = row.priceMinor
          if (row.stock != null) draft.variants[0].stock = row.stock
          if (row.barcode) draft.variants[0].barcode = row.barcode
        }
        this.library.save({ productId: item.productId, draft })
        updated += 1
      }
    })
    logMain('info', `[product-csv] 导入落库 新增=${created} 更新=${updated} 冲突=${plan.conflicts.length}`)
    return { created, updated, conflicts: plan.conflicts }
  }
}
