/**
 * 本地商品库服务（商品管理方案 §6）
 *
 * 三件事：**归并**（平台商品 → 本地商品，必须用户确认）、**本地商品 CRUD**、
 * **图片本地化入口**（真正的下载在 `ProductMediaService` 里）。
 *
 * 两条纪律：
 *   ① **绝不自动归并**（方案 D2）：合错了是两个商品被搅在一起，比不合并更糟。
 *      所以这里只有"用户点了才执行"的方法，没有"按标题猜着合并"的定时任务。
 *   ② 草稿指纹只在**内容真的变了**时才更新：它同时是"要不要重发"和发布幂等键的组成部分，
 *      乱改会让"没变"被当成"变了"（多写一次库），或把"变了"当成"没变"（该发的不发）。
 */

import { deriveProductStatus, localProductDraftHash, productDraftIssues, type LocalProductDraft } from '@shared/product-draft'
import type { ProductDraftIssue } from '@shared/product-draft'
import { planMediaQueue } from '@shared/product-media-queue-rules'
import { getDatabase } from '../db/database'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'
import { ProductMediaService, type MediaLocalizeOutcome } from './product-media-service'

export interface ProductLibraryResult {
  productId: string
  draftHash: string
  issues: ProductDraftIssue[]
  /** 保存/创建后的展示状态（issues / draft_hash / status 三者一致是 R2 DoD 的一部分） */
  status: string
}

export class ProductLibraryService {
  constructor(
    private readonly repository: ProductRepository = new ProductRepository(getDatabase()),
    private readonly media: ProductMediaService | null = null
  ) {}

  /**
   * 归并：把一个平台商品挂到某个本地商品上（用户确认过的动作）。
   *
   * 不做任何"自动找相似商品"——那属于建议，应该在界面上由用户点，不在服务里偷偷做。
   */
  merge(input: { linkId: string; productId: string }): void {
    const product = this.repository.getProduct(input.productId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    // 约束冲突（同一店铺里一个本地商品只能对一个平台商品）会让这里抛出 —— 不吞，让界面如实说
    this.repository.mergeLink(input.linkId, input.productId)
  }

  unmerge(input: { linkId: string }): void {
    this.repository.unmergeLink(input.linkId)
  }

  /**
   * 把平台商品**另存为**一个本地商品（并按用户要求直接归并过去）。
   *
   * 这是"本地商品从哪来"的主路径：列表页拿不到 SKU（四平台实测都要进详情页），
   * 所以先建一个单规格草稿，界面上再让用户补规格。
   */
  saveAsLocal(input: {
    platform: string
    storeId: string
    platformProductId: string
    /** 是否顺手把这个平台商品归并到新建的本地商品上（默认是） */
    mergeLink?: boolean
  }): ProductLibraryResult {
    const link = this.repository.linkByPlatformProduct(input)
    if (!link) throw new Error('LINK_NOT_FOUND')

    const draft: LocalProductDraft = {
      title: String(link.platform_title ?? ''),
      subtitle: null,
      description: null,
      brand: null,
      localCategory: null,
      tags: [],
      // 列表页只有商品级价格/库存 → 单规格占位（不是猜 SKU，是如实建一个待补的规格）
      variants: [{ spec: [], priceMinor: linkNumber(link.platform_price_minor), stock: linkNumber(link.platform_stock) }],
      // 图片：同步时采集到的 URL 存在 link 的 platform_image_urls_json 里（v20 补的列）。
      // 有就用真的，没有就**不假装有图** —— 界面会按"没有主图"如实提示。
      media: parseImageUrls(link.platform_image_urls_json).map((url, index) => ({
        role: index === 0 ? 'cover' : 'gallery',
        state: 'pending',
        remoteUrl: url
      }))
    }

    const draftHash = localProductDraftHash(draft)
    const productId = this.repository.createProduct({ draft, draftHash, sourceLinkId: String(link.id) })
    if (input.mergeLink !== false) {
      this.repository.mergeLink(String(link.id), productId)
    }
    const issues = productDraftIssues(draft, { platform: input.platform })
    const status = this.recomputeStatus(productId, issues)
    return { productId, draftHash, issues, status }
  }

  /** 新建空白商品（v4 §3.1 R2）：创建即进编辑器；标题给默认占位，内容靠编辑器补齐。 */
  createBlank(input: { title?: string } = {}): { productId: string; draftHash: string; issues: ProductDraftIssue[]; status: string } {
    return this.createFromDraft({
      title: (input.title ?? '').trim() || '未命名商品',
      subtitle: null, description: null, brand: null, localCategory: null, tags: [], variants: [], media: []
    })
  }

  /** 按完整草稿新建（v4 §3.6 R3 CSV 导入"新增"走这里；与空白新建同一套指纹/重算语义）。 */
  createFromDraft(draft: LocalProductDraft): { productId: string; draftHash: string; issues: ProductDraftIssue[]; status: string } {
    const draftHash = localProductDraftHash(draft)
    const productId = this.repository.createProduct({ draft, draftHash, sourceLinkId: null })
    const issues = productDraftIssues(draft)
    const status = this.recomputeStatus(productId, issues)
    return { productId, draftHash, issues, status }
  }

  /**
   * 复制本地商品（v4 §3.1 R2）。
   *
   * 媒体文件零复制：行引用同一 local_path/sha256（迁移 v32 的每商品唯一索引允许），
   * DoD 的"sha256 复用断言"就是验证这一点。复制完成后按新内容重算指纹与状态
   * （占位指纹来自源商品，必须覆盖掉，否则发布幂等键会串）。
   */
  duplicate(input: { productId: string }): { productId: string; draftHash: string; issues: ProductDraftIssue[]; status: string } {
    const newId = this.repository.duplicateProduct(input.productId)
    if (!newId) throw new Error('PRODUCT_NOT_FOUND')
    const product = this.repository.getProduct(newId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    const draftHash = localProductDraftHash(product.draft)
    this.repository.updateProduct({ productId: newId, draft: product.draft, draftHash })
    const issues = productDraftIssues(product.draft)
    const status = this.recomputeStatus(newId, issues)
    return { productId: newId, draftHash, issues, status }
  }

  /** 归档 / 取消归档（v4 §3.3）：archived 是显式态——归档直接置；取消归档先清显式态再按内容重算（否则重算协议会一直尊重 archived 出不来）。 */
  setArchived(input: { productId: string; archived: boolean }): { status: string } {
    if (input.archived) {
      this.repository.setProductStatus(input.productId, 'archived')
      return { status: 'archived' }
    }
    this.repository.setProductStatus(input.productId, 'draft')
    return { status: this.recomputeStatus(input.productId) }
  }

  /**
   * 彻底删除（v4 §3.4 R2）：仅限**无发布记录**的商品（有证据的台账必须留）。
   * 级联删规格/媒体行；平台链接回到「未归并」；**绝不删磁盘文件**（孤儿清理负责）。
   */
  purge(input: { productId: string }): { variants: number; media: number } {
    const result = this.repository.purgeProduct(input.productId)
    logMain('info', `[product-library] 彻底删除 product=${input.productId.slice(0, 8)} 规格=${result.variants} 媒体行=${result.media}（磁盘文件保留，交孤儿清理判定）`)
    return result
  }

  /**
   * 状态重算（v4 §4.4 的单点维护协议）。
   *
   * 2026-10-15 审查实测：`products.status` 曾是死字段（只写 'draft'、零更新点）。
   * 现在所有会改变"草稿完整度"的写路径（save / saveAsLocal / restore / 未来的 create/duplicate）
   * 都在完成后调用这里；`archived` 是显式态，重算不覆盖它。
   */
  private recomputeStatus(productId: string, issues?: ProductDraftIssue[]): string {
    const product = this.repository.getProduct(productId)
    if (!product) return 'draft'
    if (product.status === 'archived') return 'archived'
    const finalIssues = issues ?? productDraftIssues(product.draft, { platform: this.repository.platformsForProduct(productId)[0] })
    const next = deriveProductStatus(finalIssues, { archived: false })
    if (next !== product.status) this.repository.setProductStatus(productId, next)
    return next
  }

  /** 恢复软删商品（v4 §3.4）：放回主列表并按内容重算状态；**不自动恢复平台归并**（D2）。 */
  restore(input: { productIds: readonly string[] }): { restored: number; statuses: Record<string, string> } {
    const restored = this.repository.restoreProducts(input.productIds)
    const statuses: Record<string, string> = {}
    for (const id of input.productIds) statuses[id] = this.recomputeStatus(id)
    return { restored, statuses }
  }

  /** 升级回填（v4 §4.4）：一次性重算全部未删商品的展示状态（幂等；调用方负责写完成标记）。 */
  recomputeAllStatuses(): { checked: number; changed: number } {
    let changed = 0
    const candidates = this.repository.listStatusCandidates()
    for (const candidate of candidates) {
      if (this.recomputeStatus(candidate.id) !== candidate.status) changed += 1
    }
    return { checked: candidates.length, changed }
  }

  /** 读本地商品（编辑抽屉）。 */
  get(input: { productId: string }): { id: string; status: string; draftHash: string; draft: LocalProductDraft; issues: ProductDraftIssue[]; linkedCount: number } {
    const product = this.repository.getProduct(input.productId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    const linked = this.repository.listLinks({ limit: 200 }).rows.filter(row => row.productId === input.productId)
    return {
      id: product.id,
      status: product.status,
      draftHash: product.draftHash,
      draft: product.draft,
      issues: productDraftIssues(product.draft, { platform: linked[0]?.platform }),
      linkedCount: linked.length
    }
  }

  /** 保存本地商品（编辑抽屉提交完整草稿）。返回分级校验结果，界面据此提示。 */
  save(input: { productId: string; draft: LocalProductDraft; platform?: string }): ProductLibraryResult {
    const product = this.repository.getProduct(input.productId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    const issues = productDraftIssues(input.draft, { platform: input.platform })
    // 有 blocker 仍然允许保存（草稿态本来就不完整），但把 issues 如实返回给界面；
    // 真正的门禁在**发布**那一步（方案 §7.2 预检）。
    const draftHash = localProductDraftHash(input.draft)
    this.repository.updateProduct({ productId: input.productId, draft: input.draft, draftHash })
    const status = this.recomputeStatus(input.productId, issues)
    return { productId: input.productId, draftHash, issues, status }
  }

  /** 软删（硬删会把发布台账级联掉）。 */
  remove(input: { productId: string }): void {
    const product = this.repository.getProduct(input.productId)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    this.repository.softDeleteProduct(input.productId)
  }

  /** 图片本地化（真正的下载与安全校验在 ProductMediaService）。 */
  async localizeMedia(input: { productId: string }): Promise<MediaLocalizeOutcome> {
    if (!this.media) throw new Error('MEDIA_SERVICE_UNAVAILABLE')
    return this.media.localizeProduct(input.productId)
  }

  /** 添加本地图片（v4 §3.3 R2）：校验/落盘后返回草稿媒体条目，编辑器并进自己的草稿随保存落库。 */
  async importLocalImages(input: { productId: string; absolutePaths: readonly string[]; role: 'cover' | 'gallery' | 'detail' }): Promise<{
    imported: Array<{ role: 'cover' | 'gallery' | 'detail'; state: 'localized'; localPath: string; sha256: string }>
    skipped: Array<{ path: string; reason: string }>
  }> {
    if (!this.media) throw new Error('MEDIA_SERVICE_UNAVAILABLE')
    return this.media.importLocalImages(input)
  }

  // ---------------------------------------------------------------- 图片本地化队列（保留策略）

  /** 扫出**待办队列**（全部本地商品里还没本地化的图），按主图优先排好序。 */
  scanMediaQueue(input: { maxItems?: number } = {}): ReturnType<typeof planMediaQueue> & { candidates: number } {
    const candidates = this.repository.listMediaQueueCandidates().map(row => ({
      ...row,
      // 台账里的 state 是 TEXT，规则层用的是字面量联合。这里显式收窄；
      // 认不出来的状态按 `failed` 处理（**保守**：宁可多试一次，也不当成"已完成"跳过）
      state: (['pending', 'localized', 'failed', 'blocked', 'missing'] as const).includes(row.state as never)
        ? (row.state as 'pending' | 'localized' | 'failed' | 'blocked' | 'missing')
        : ('failed' as const)
    }))
    const plan = planMediaQueue({ candidates, maxItems: input.maxItems })
    return { ...plan, candidates: candidates.length }
  }

  /**
   * 跑一次队列：按队列顺序逐张下载。
   *
   * 复用 `localizeProduct`（**已经端到端验证过的那条路径**：Session 下载 → 安全校验 → 去重 → 落盘），
   * 而不是在这里重写一遍下载逻辑 —— 那样两条路必然分叉。
   * 每个商品的媒体整体处理完，再如实汇报每张的结果。
   */
  async runMediaQueue(input: { maxItems?: number } = {}): Promise<{
    products: number
    localized: number
    deduped: number
    failed: number
    blocked: number
    summary: string
  }> {
    if (!this.media) throw new Error('MEDIA_SERVICE_UNAVAILABLE')
    const plan = this.scanMediaQueue({ maxItems: input.maxItems })
    // 只处理"这次真的会去下"的项；按商品分组（同一商品的图连着下，减少页面/会话切换）
    const productIds: string[] = []
    for (const item of plan.items) {
      if (!item.shouldAttempt) continue
      if (!productIds.includes(item.productId)) productIds.push(item.productId)
    }

    let localized = 0, deduped = 0, failed = 0, blocked = 0
    // **批大小上限要真的生效**：每个商品只处理"还剩多少预算"那么多张。
    // 实测踩到：`maxItems` 只限制计划条数，而 `localizeProduct` 会把商品全部图跑完 ——
    // 用户点"这一批 6 张"，一个 500 张图的商品能跑一小时。
    let budget = input.maxItems ?? Number.POSITIVE_INFINITY
    for (const productId of productIds) {
      if (budget <= 0) break
      try {
        const outcome = await this.media.localizeProduct(productId, { maxItems: Number.isFinite(budget) ? budget : undefined })
        localized += outcome.localized
        deduped += outcome.deduped
        failed += outcome.failed
        blocked += outcome.blocked
        budget -= outcome.total
      } catch (error) {
        // 单个商品失败不影响队列其余部分（批量下"一家失败拖垮全部"是最糟的形态）
        failed += 1
        budget -= 1
        logMain('warn', `[product-media] 队列里这个商品失败了 product=${productId}：${String((error as Error)?.message || error).slice(0, 120)}`)
      }
    }
    logMain('info', `[product-media] 队列完成 商品=${productIds.length} 本地化=${localized} 重复=${deduped} 失败=${failed} 拒绝=${blocked}`)
    return {
      products: productIds.length, localized, deduped, failed, blocked,
      summary: productIds.length
        ? `队列跑完 ${productIds.length} 个商品：本地化 ${localized}、重复 ${deduped}、失败 ${failed}、拒绝 ${blocked}`
        : '队列里没有需要处理的图片'
    }
  }

  /** 扫孤儿文件（**只判定不删**）。 */
  async scanOrphanMedia(): Promise<{ orphans: unknown[]; keepCount: number; orphanBytes: number; summary: string }> {
    if (!this.media) throw new Error('MEDIA_SERVICE_UNAVAILABLE')
    return this.media.scanOrphans()
  }

  /** 清理孤儿文件（**用户确认后**才调用）。 */
  async cleanupOrphanMedia(): Promise<{ deleted: number; bytes: number; failed: number; summary: string }> {
    if (!this.media) throw new Error('MEDIA_SERVICE_UNAVAILABLE')
    return this.media.cleanupOrphans()
  }
}

function linkNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 解析 link 行里的图片 URL 数组；坏数据返回空数组（不抛）。 */
function parseImageUrls(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && !!item) : []
  } catch {
    return []
  }
}

/**
 * 升级后的一次性状态回填（v4 §4.4），启动段调用。
 *
 * 幂等：`app_settings['product.status_backfill_v4']` 写过就跳过；失败只记日志、**不阻塞启动**
 * （状态是展示层字段，发布门禁看的是 draft_hash，不属于启动关键路径）。
 */
export function backfillProductStatusesIfNeeded(): void {
  const FLAG_KEY = 'product.status_backfill_v4'
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(FLAG_KEY) as { value_json?: string } | undefined
    if (row) return
    const result = new ProductLibraryService().recomputeAllStatuses()
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(FLAG_KEY, JSON.stringify({ done: true, ...result, at: Date.now() }), Date.now())
    logMain('info', `[product-status] 回填完成 checked=${result.checked} changed=${result.changed}`)
  } catch (error) {
    logMain('warn', `[product-status] 回填失败（不阻塞启动）：${String((error as Error)?.message || error).slice(0, 200)}`)
  }
}
