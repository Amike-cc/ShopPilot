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

import { localProductDraftHash, productDraftIssues, type LocalProductDraft } from '@shared/product-draft'
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
    return { productId, draftHash, issues: productDraftIssues(draft, { platform: input.platform }) }
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
    return { productId: input.productId, draftHash, issues }
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
