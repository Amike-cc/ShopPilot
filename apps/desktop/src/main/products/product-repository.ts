/**
 * 商品仓储（商品管理方案 §4 / §5.5）
 *
 * 只做"数据怎么进出 SQLite"这一件事，不含任何平台知识（平台相关的解析在适配器里）。
 *
 * 三条与订单/经营指标仓储保持一致的口径：
 *   1) **金额分为单位整数**（`*_minor`），时间毫秒整数；
 *   2) 平台原值写 `product_platform_links.platform_*`，**本地编辑值写 products**，两者不互相覆盖；
 *   3) 平台商品与本地商品**不自动合并**（`product_id` 留空，等用户确认）。
 */

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { PlatformProduct, PlatformProductStatus } from '@shared/contracts/platform-product'
import type { LocalProductDraft } from '@shared/product-draft'
import { logMain } from '../services/logger'

export interface ProductUpsertCounts {
  inserted: number
  updated: number
  /** 内容完全一致 → 不写库（避免无谓的 WAL 增长） */
  skipped: number
  /** 本轮没出现、被标成 missing 的条数（只有全量轮次才会标记） */
  missing: number
}

export interface ProductSyncRunRow {
  id: string
  storeId: string
  trigger: string
  status: string
  reasonCode: string | null
  fetchedCount: number
  insertedCount: number
  updatedCount: number
  missingCount: number
  skippedCount: number
  hasMore: number
  pageCount: number
  durationMs: number | null
  startedAt: number
  finishedAt: number | null
  safeMessage: string | null
}

export interface ProductLinkRow {
  linkId: string
  platform: string
  storeId: string
  storeName: string
  platformProductId: string
  platformTitle: string | null
  platformStatus: PlatformProductStatus | null
  platformPriceMinor: number | null
  platformStock: number | null
  platformUpdatedAt: number | null
  collectedAt: number
  /** 为空 = 平台上发现、本地还没有归属 */
  productId: string | null
  productTitle: string | null
}

export interface ProductLinkQuery {
  storeId?: string
  platform?: string
  /** 只看"平台上发现、本地未归并"的 */
  onlyOrphan?: boolean
  keyword?: string
  limit?: number
  offset?: number
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

/**
 * 一行平台商品的内容指纹。
 *
 * 只放"会影响展示与决策"的字段：标题、状态、价格、库存、**图片地址**、更新时间、SKU 数。
 * 不放 rawRow 的整串（那里面包含平台页面的排版噪声，会让"没变"被误判成"变了"）。
 *
 * 图片地址为什么必须进指纹（2026-09-30 M2 验收踩到）：它不只是"张数"——
 * 图片本地化要用它去下载。曾出现"这一行只差图片地址（张数一样）"的情况，
 * 指纹说没变 → 跳过 → 图片地址永远是空的，整条本地化链路没有输入。
 */
export function productSnapshotOf(product: PlatformProduct): string {
  return JSON.stringify({
    t: product.title,
    s: product.status,
    p: product.priceMinor,
    k: product.stock,
    i: product.imageUrls.length,
    // 图片地址本身（顺序有意义：第一张是主图）
    u: product.imageUrls.join('|'),
    a: product.platformUpdatedAt,
    n: product.skus.length
  })
}

/**
 * 落库用的快照串：**指纹 + 整行原文**。
 *
 * 为什么不只存原文：原文里包含平台页面的排版噪声（实测同一商品两次采集的单元格文本可能差一个空格），
 * 拿它判断"变没变"会把"没变"误判成"变了"，于是每轮都全量 UPDATE。
 * 为什么不只存指纹：出问题时需要原文来比对（这是 raw_snapshot 存在的意义）。
 * 两者一起存，比较用 `f`，排障用 `r`。
 */
export function snapshotJsonOf(product: PlatformProduct): string {
  return JSON.stringify({ f: productSnapshotOf(product), r: product.rawRow ?? [] })
}

/** 从落库的快照串里取出指纹；旧数据/解析不了返回 null（当作"变了"，宁可多写一次也不漏更新）。 */
export function storedFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw) as { f?: unknown }
    return typeof parsed?.f === 'string' ? parsed.f : null
  } catch {
    return null
  }
}

export class ProductRepository {
  constructor(private readonly db: Database.Database) {}

  // ------------------------------------------------------------ 同步台账

  startSyncRun(input: { storeId: string; trigger: 'manual' | 'schedule'; startedAt: number }): string {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO product_sync_runs (id, store_id, trigger, status, started_at)
      VALUES (?, ?, ?, 'RUNNING', ?)
    `).run(id, input.storeId, input.trigger, input.startedAt)
    return id
  }

  finishSyncRun(input: {
    runId: string
    status: string
    reasonCode: string | null
    fetchedCount: number
    insertedCount: number
    updatedCount: number
    missingCount: number
    skippedCount: number
    hasMore: boolean
    pageCount: number
    durationMs: number
    safeMessage: string | null
    finishedAt: number
  }): void {
    this.db.prepare(`
      UPDATE product_sync_runs SET
        status = ?, reason_code = ?, fetched_count = ?, inserted_count = ?, updated_count = ?,
        missing_count = ?, skipped_count = ?, has_more = ?, page_count = ?, duration_ms = ?,
        safe_message = ?, finished_at = ?
      WHERE id = ?
    `).run(
      input.status, input.reasonCode, input.fetchedCount, input.insertedCount, input.updatedCount,
      input.missingCount, input.skippedCount, input.hasMore ? 1 : 0, input.pageCount, input.durationMs,
      input.safeMessage, input.finishedAt, input.runId
    )
  }

  latestSyncRun(storeId: string): ProductSyncRunRow | null {
    const row = this.db.prepare(`
      SELECT * FROM product_sync_runs WHERE store_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(storeId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      storeId: String(row.store_id),
      trigger: String(row.trigger),
      status: String(row.status),
      reasonCode: nullableString(row.reason_code),
      fetchedCount: Number(row.fetched_count ?? 0),
      insertedCount: Number(row.inserted_count ?? 0),
      updatedCount: Number(row.updated_count ?? 0),
      missingCount: Number(row.missing_count ?? 0),
      skippedCount: Number(row.skipped_count ?? 0),
      hasMore: Number(row.has_more ?? 0),
      pageCount: Number(row.page_count ?? 0),
      durationMs: nullableNumber(row.duration_ms),
      startedAt: Number(row.started_at ?? 0),
      finishedAt: nullableNumber(row.finished_at),
      safeMessage: nullableString(row.safe_message)
    }
  }

  // ------------------------------------------------------------ 采集落库

  /**
   * 一轮采集的结果落库。**整体一个事务**：任一环节抛错 → 整轮回滚，不留"半轮"数据。
   *
   * `markMissing` 只有**全量轮次**才允许为 true：增量轮次没拉到的商品不能算"平台上消失了"
   * （这是最容易搞错的一条，见方案 §5.7）。
   */
  upsertCollected(input: {
    storeId: string
    platform: string
    products: readonly PlatformProduct[]
    collectedAt: number
    markMissing: boolean
  }): ProductUpsertCounts {
    const counts: ProductUpsertCounts = { inserted: 0, updated: 0, skipped: 0, missing: 0 }
    const selectStmt = this.db.prepare(`
      SELECT id, raw_snapshot_json, platform_status FROM product_platform_links
      WHERE platform = ? AND store_id = ? AND platform_product_id = ?
    `)
    const insertStmt = this.db.prepare(`
      INSERT INTO product_platform_links (
        id, product_id, platform, store_id, platform_product_id,
        platform_title, platform_subtitle, platform_status, platform_price_minor, platform_stock,
        platform_category_path, platform_image_count, platform_image_urls_json, platform_updated_at,
        first_seen_at, collected_at, raw_snapshot_json
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateStmt = this.db.prepare(`
      UPDATE product_platform_links SET
        platform_title = ?, platform_subtitle = ?, platform_status = ?, platform_price_minor = ?,
        platform_stock = ?, platform_category_path = ?, platform_image_count = ?, platform_image_urls_json = ?,
        platform_updated_at = ?, collected_at = ?, raw_snapshot_json = ?
      WHERE id = ?
    `)
    const seenIds: string[] = []

    const run = this.db.transaction(() => {
      for (const product of input.products) {
        if (!product.platformProductId) continue      // 没有平台商品 ID 就没有幂等键，宁可跳过
        const fingerprint = productSnapshotOf(product)
        const snapshot = snapshotJsonOf(product)
        const existing = selectStmt.get(input.platform, input.storeId, product.platformProductId) as
          { id: string; raw_snapshot_json: string | null; platform_status: string | null } | undefined

        if (!existing) {
          const newId = randomUUID()
          insertStmt.run(
            newId, input.platform, input.storeId, product.platformProductId,
            product.title, product.subtitle, product.status, product.priceMinor, product.stock,
            product.categoryPath, product.imageUrls.length, JSON.stringify(product.imageUrls ?? []), product.platformUpdatedAt,
            input.collectedAt, input.collectedAt, snapshot
          )
          // **必须收进 seenIds**：否则本轮刚插入的商品会在同一个事务里的"标 missing"语句里
          // 被自己标成 missing（2026-09-30 单测抓到：首次同步后所有商品全是 missing）。
          seenIds.push(newId)
          counts.inserted += 1
          continue
        }

        seenIds.push(existing.id)
        // 「复活」必须能生效：标 missing 时**只改了 platform_status、没改指纹**，
        // 所以只看指纹会把"平台上消失又回来的商品"永远当成"没变"跳过，
        // 状态一直卡在 missing（2026-09-30 四平台验收实测到）。
        // 因此状态与指纹**任一变化**都要写库。
        const statusChanged = (existing.platform_status ?? '') !== product.status
        if (!statusChanged && storedFingerprint(existing.raw_snapshot_json) === fingerprint) {
          // 内容没变：不写库（避免无谓的 WAL 增长）
          counts.skipped += 1
          continue
        }
        updateStmt.run(
          product.title, product.subtitle, product.status, product.priceMinor, product.stock,
          product.categoryPath, product.imageUrls.length, JSON.stringify(product.imageUrls ?? []), product.platformUpdatedAt,
          input.collectedAt, snapshot, existing.id
        )
        counts.updated += 1
      }

      if (input.markMissing) {
        // 全量轮次：本轮没出现的（除已标 missing 的）→ 标记为 missing，**不删行**
        const placeholders = seenIds.length ? seenIds.map(() => '?').join(',') : null
        const sql = `
          UPDATE product_platform_links SET platform_status = 'missing', collected_at = ?
          WHERE platform = ? AND store_id = ?
            AND COALESCE(platform_status, '') != 'missing'
            ${placeholders ? `AND id NOT IN (${placeholders})` : ''}
        `
        const params: unknown[] = [input.collectedAt, input.platform, input.storeId, ...seenIds]
        const result = this.db.prepare(sql).run(...params)
        counts.missing = Number(result.changes ?? 0)
      }
    })

    run()
    return counts
  }

  // ------------------------------------------------------------ 查询（界面用）

  listLinks(query: ProductLinkQuery): { rows: ProductLinkRow[]; total: number } {
    const where: string[] = []
    const params: unknown[] = []
    if (query.storeId) { where.push('l.store_id = ?'); params.push(query.storeId) }
    if (query.platform) { where.push('l.platform = ?'); params.push(query.platform) }
    if (query.onlyOrphan) where.push('l.product_id IS NULL')
    if (query.keyword) {
      where.push('(l.platform_title LIKE ? OR p.title LIKE ?)')
      params.push(`%${query.keyword}%`, `%${query.keyword}%`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200)
    const offset = Math.max(Number(query.offset ?? 0), 0)

    const rows = this.db.prepare(`
      SELECT l.id AS link_id, l.platform, l.store_id, l.platform_product_id, l.platform_title,
             l.platform_status, l.platform_price_minor, l.platform_stock, l.platform_updated_at,
             l.collected_at, l.product_id, p.title AS product_title, s.name AS store_name
      FROM product_platform_links l
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN stores s ON s.id = l.store_id
      ${whereSql}
      ORDER BY l.collected_at DESC, l.platform_title ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>

    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS c FROM product_platform_links l
      LEFT JOIN products p ON p.id = l.product_id
      ${whereSql}
    `).get(...params) as { c: number } | undefined

    return {
      rows: rows.map(row => ({
        linkId: String(row.link_id),
        platform: String(row.platform),
        storeId: String(row.store_id),
        storeName: nullableString(row.store_name) ?? '',
        platformProductId: String(row.platform_product_id),
        platformTitle: nullableString(row.platform_title),
        platformStatus: (nullableString(row.platform_status) as PlatformProductStatus | null) ?? null,
        platformPriceMinor: nullableNumber(row.platform_price_minor),
        platformStock: nullableNumber(row.platform_stock),
        platformUpdatedAt: nullableNumber(row.platform_updated_at),
        collectedAt: Number(row.collected_at ?? 0),
        productId: nullableString(row.product_id),
        productTitle: nullableString(row.product_title)
      })),
      total: Number(totalRow?.c ?? 0)
    }
  }

  /** 每个店铺的商品条数（界面左侧筛选与"未实测/无商品"的区分要靠它）。 */
  countByStore(): Array<{ storeId: string; platform: string; total: number; orphan: number }> {
    const rows = this.db.prepare(`
      SELECT store_id, platform, COUNT(*) AS total,
             SUM(CASE WHEN product_id IS NULL THEN 1 ELSE 0 END) AS orphan
      FROM product_platform_links GROUP BY store_id, platform
    `).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      storeId: String(row.store_id),
      platform: String(row.platform),
      total: Number(row.total ?? 0),
      orphan: Number(row.orphan ?? 0)
    }))
  }

  // ------------------------------------------------------------ 本地商品（M2）

  /** 新建本地商品。`draft_hash` 由调用方用 `localProductDraftHash` 算好传进来（规则在 shared，只有一份）。 */
  createProduct(input: {
    draft: LocalProductDraft
    draftHash: string
    sourceLinkId?: string | null
    now?: number
  }): string {
    const id = randomUUID()
    const now = input.now ?? Date.now()
    const run = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO products (id, title, subtitle, description, brand, local_category, tags_json,
                              status, draft_hash, source_link_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
      `).run(
        id, input.draft.title, input.draft.subtitle ?? null, input.draft.description ?? null,
        input.draft.brand ?? null, input.draft.localCategory ?? null,
        JSON.stringify(input.draft.tags ?? []), input.draftHash, input.sourceLinkId ?? null, now, now
      )
      this.replaceVariants(id, input.draft, now)
      this.replaceMedia(id, input.draft, now)
    })
    run()
    return id
  }

  /** 更新本地商品（规格与图片**整体替换**：编辑抽屉提交的是完整草稿）。 */
  updateProduct(input: { productId: string; draft: LocalProductDraft; draftHash: string; now?: number }): void {
    const now = input.now ?? Date.now()
    const run = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE products SET title = ?, subtitle = ?, description = ?, brand = ?, local_category = ?,
                            tags_json = ?, draft_hash = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        input.draft.title, input.draft.subtitle ?? null, input.draft.description ?? null,
        input.draft.brand ?? null, input.draft.localCategory ?? null,
        JSON.stringify(input.draft.tags ?? []), input.draftHash, now, input.productId
      )
      this.replaceVariants(input.productId, input.draft, now)
      this.replaceMedia(input.productId, input.draft, now)
    })
    run()
  }

  /** 规格整体替换。注意：替换会让 `product_sku_links.variant_id` 因 FK `ON DELETE SET NULL` 变成空 —— 这是对的，旧映射本来就失效了。 */
  private replaceVariants(productId: string, draft: LocalProductDraft, now: number): void {
    this.db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId)
    const insert = this.db.prepare(`
      INSERT INTO product_variants (id, product_id, spec_json, sku_code, price_minor, stock, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    draft.variants.forEach((variant, index) => {
      insert.run(randomUUID(), productId, JSON.stringify(variant.spec ?? []), variant.skuCode ?? null,
        variant.priceMinor ?? null, variant.stock ?? null, index, now, now)
    })
  }

  /**
   * 图片整体替换。
   *
   * `sha256` 唯一索引会把"同一张图重复插入"挡下来 → 这里用 `INSERT OR IGNORE` 后再按需更新，
   * 保证同图只留一行（与"同图只存一份文件"的设计一致）。
   */
  private replaceMedia(productId: string, draft: LocalProductDraft, now: number): void {
    const existing = this.db.prepare('SELECT id, sha256 FROM product_media WHERE product_id = ?')
      .all(productId) as Array<{ id: string; sha256: string | null }>
    const bySha = new Map(existing.filter(row => row.sha256).map(row => [String(row.sha256), row.id]))
    this.db.prepare('DELETE FROM product_media WHERE product_id = ?').run(productId)

    const insert = this.db.prepare(`
      INSERT INTO product_media (id, product_id, role, origin, remote_url, local_path, sha256, state, fail_reason, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const stateCounts: Record<string, number> = {}
    draft.media.forEach((item, index) => {
      const state = item.state ?? 'pending'
      stateCounts[state] = (stateCounts[state] ?? 0) + 1
      insert.run(randomUUID(), productId, item.role, 'platform', item.remoteUrl ?? null,
        (item as { localPath?: string | null }).localPath ?? null,
        (item as { sha256?: string | null }).sha256 ?? null,
        state, (item as { failReason?: string | null }).failReason ?? null,
        index, now)
    })
    // 写回后**如实记下写成了什么状态**：这类"界面说处理了、库里还是 pending"的问题，
    // 只看调用方代码是查不出来的（2026-09-30 就是这么卡住的），必须让写回自己说话。
    logMain('info', `[product-media] 写回媒体行 product=${productId.slice(0, 8)} 共 ${draft.media.length} 行 状态分布=${JSON.stringify(stateCounts)}`)
    void bySha
  }

  /** 读一个本地商品的完整草稿（编辑抽屉用）。 */
  getProduct(productId: string): {
    id: string
    status: string
    draftHash: string
    createdAt: number
    updatedAt: number
    draft: LocalProductDraft
    sourceLinkId: string | null
  } | null {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as Record<string, unknown> | undefined
    if (!row) return null
    const variants = this.db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order').all(productId) as Array<Record<string, unknown>>
    const media = this.db.prepare('SELECT * FROM product_media WHERE product_id = ? ORDER BY sort_order').all(productId) as Array<Record<string, unknown>>
    return {
      id: String(row.id),
      status: String(row.status),
      draftHash: String(row.draft_hash),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      sourceLinkId: nullableString(row.source_link_id),
      draft: {
        title: String(row.title ?? ''),
        subtitle: nullableString(row.subtitle),
        description: nullableString(row.description),
        brand: nullableString(row.brand),
        localCategory: nullableString(row.local_category),
        tags: parseJsonArray(row.tags_json),
        variants: variants.map(variant => ({
          spec: parseJsonArray<{ name: string; value: string }>(variant.spec_json),
          priceMinor: nullableNumber(variant.price_minor),
          stock: nullableNumber(variant.stock),
          skuCode: nullableString(variant.sku_code)
        })),
        media: media.map(item => ({
          role: String(item.role) as 'cover' | 'gallery' | 'detail' | 'sku',
          state: String(item.state) as 'pending' | 'localized' | 'failed' | 'blocked' | 'missing',
          remoteUrl: nullableString(item.remote_url),
          localPath: nullableString(item.local_path),
          sha256: nullableString(item.sha256),
          failReason: nullableString(item.fail_reason)
        })) as LocalProductDraft['media']
      }
    }
  }

  /** 本地商品列表（界面左栏）。 */
  listProducts(query: { keyword?: string; limit?: number; offset?: number } = {}): { rows: Array<{ id: string; title: string; status: string; updatedAt: number; variantCount: number; coverState: string | null; linkCount: number }>; total: number } {
    const where: string[] = ['p.deleted_at IS NULL']
    const params: unknown[] = []
    if (query.keyword) { where.push('p.title LIKE ?'); params.push(`%${query.keyword}%`) }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200)
    const offset = Math.max(Number(query.offset ?? 0), 0)
    const rows = this.db.prepare(`
      SELECT p.id, p.title, p.status, p.updated_at,
             (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
             (SELECT state FROM product_media m WHERE m.product_id = p.id AND m.role = 'cover' ORDER BY m.sort_order LIMIT 1) AS cover_state,
             (SELECT COUNT(*) FROM product_platform_links l WHERE l.product_id = p.id) AS link_count
      FROM products p ${whereSql}
      ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM products p ${whereSql}`).get(...params) as { c: number } | undefined
    return {
      rows: rows.map(row => ({
        id: String(row.id),
        title: String(row.title ?? ''),
        status: String(row.status),
        updatedAt: Number(row.updated_at ?? 0),
        variantCount: Number(row.variant_count ?? 0),
        coverState: nullableString(row.cover_state),
        linkCount: Number(row.link_count ?? 0)
      })),
      total: Number(totalRow?.c ?? 0)
    }
  }

  softDeleteProduct(productId: string, now = Date.now()): void {
    // 软删：硬删会把发布台账（审计材料）级联掉。
    // 同时**把它的平台商品放回"未归并"**：本地商品既然删了，那些平台商品就没有本地归属了；
    // 不解绑的话界面会继续显示一个已经删掉的商品标题（2026-09-30 UI 验收看到）。
    const run = this.db.transaction(() => {
      this.db.prepare('UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, productId)
      this.db.prepare('UPDATE product_platform_links SET product_id = NULL WHERE product_id = ?').run(productId)
    })
    run()
  }

  /**
   * 归并：把平台商品挂到本地商品上。
   *
   * `UNIQUE(store_id, product_id)` 会挡住"同一店铺里把一个本地商品挂到两个平台商品上"
   * （防"发重了"被当成两条合法记录）—— 这里**不吞异常**，让上层如实告诉用户。
   */
  mergeLink(linkId: string, productId: string, now = Date.now()): void {
    this.db.prepare('UPDATE product_platform_links SET product_id = ? WHERE id = ?').run(productId, linkId)
    this.db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(now, productId)
  }

  unmergeLink(linkId: string): void {
    this.db.prepare('UPDATE product_platform_links SET product_id = NULL WHERE id = ?').run(linkId)
  }

  /** 按平台商品 ID 找 link（界面点"并入/另存为"时用）。 */
  linkByPlatformProduct(input: { platform: string; storeId: string; platformProductId: string }): Record<string, unknown> | null {
    return (this.db.prepare(`
      SELECT * FROM product_platform_links WHERE platform = ? AND store_id = ? AND platform_product_id = ?
    `).get(input.platform, input.storeId, input.platformProductId) as Record<string, unknown> | undefined) ?? null
  }

  /**
   * 用详情页读到的商品图替换列表页那张缩略图。
   *
   * 为什么必须替换：列表页的图实测是 **SVG**（本地化会如实拒绝），详情页才是 WebP 真图。
   * 同时**不动内容指纹**（`raw_snapshot_json`）——图集来自详情页、列表页的指纹是列表页的事，
   * 混在一起会让下一轮同步误判成"列表页变了"。
   */
  updateLinkImages(input: { linkId: string; imageUrls: readonly string[]; now?: number }): void {
    const urls = input.imageUrls.filter(url => typeof url === 'string' && url)
    this.db.prepare(`
      UPDATE product_platform_links SET platform_image_urls_json = ?, platform_image_count = ?
      WHERE id = ?
    `).run(JSON.stringify(urls), urls.length, input.linkId)
  }

  /**
   * 写平台侧的 SKU 映射。
   *
   * `variant_id` 留空 = "平台有这个 SKU，本地还没对上" —— 这正是 `product_sku_links` 设计里的
   * 第一种情况（方案 §4.6），界面据此提示用户去补规格，而不是我们替他猜配对。
   * 平台侧消失的旧 SKU 标 `missing`（**不删行**，下次出现可复活）。
   */
  replaceLinkSkus(input: {
    linkId: string
    skus: ReadonlyArray<{ platformSkuId: string; spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null }>
    now?: number
  }): { inserted: number; missing: number } {
    const now = input.now ?? Date.now()
    let inserted = 0
    let missing = 0
    const run = this.db.transaction(() => {
      const seen: string[] = []
      const upsert = this.db.prepare(`
        INSERT INTO product_sku_links (id, link_id, variant_id, platform_sku_id, platform_spec_json,
                                       platform_price_minor, platform_stock, state, collected_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(link_id, platform_sku_id) DO UPDATE SET
          platform_spec_json = excluded.platform_spec_json,
          platform_price_minor = excluded.platform_price_minor,
          platform_stock = excluded.platform_stock,
          state = 'active',
          collected_at = excluded.collected_at
      `)
      for (const sku of input.skus) {
        if (!sku.platformSkuId) continue
        const existing = this.db.prepare('SELECT id FROM product_sku_links WHERE link_id = ? AND platform_sku_id = ?')
          .get(input.linkId, sku.platformSkuId) as { id: string } | undefined
        upsert.run(randomUUID(), input.linkId, sku.platformSkuId, JSON.stringify(sku.spec ?? []),
          sku.priceMinor ?? null, sku.stock ?? null, now)
        if (!existing) inserted += 1
        seen.push(sku.platformSkuId)
      }
      const placeholders = seen.length ? seen.map(() => '?').join(',') : null
      const result = this.db.prepare(`
        UPDATE product_sku_links SET state = 'missing', collected_at = ?
        WHERE link_id = ? AND state != 'missing'
        ${placeholders ? `AND platform_sku_id NOT IN (${placeholders})` : ''}
      `).run(now, input.linkId, ...seen)
      missing = Number(result.changes ?? 0)
    })
    run()
    return { inserted, missing }
  }

  // ------------------------------------------------------------ 图片本地化队列（保留策略）

  /**
   * 扫出**所有**本地商品里还没本地化的媒体行（队列的输入）。
   *
   * 只扫未软删商品的媒体行：软删商品的图不在队列里（它们保留是审计窗口，不该被重新下载）。
   */
  listMediaQueueCandidates(): Array<{
    productId: string; mediaId: string; role: 'cover' | 'gallery' | 'detail' | 'sku'
    state: string; remoteUrl: string | null; attempts: number; sortOrder: number
  }> {
    const rows = this.db.prepare(`
      SELECT m.id AS media_id, m.product_id, m.role, m.state, m.remote_url, m.attempts, m.sort_order
      FROM product_media m
      JOIN products p ON p.id = m.product_id
      WHERE p.deleted_at IS NULL AND m.state != 'localized'
      ORDER BY m.sort_order
    `).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      productId: String(row.product_id),
      mediaId: String(row.media_id),
      role: String(row.role) as 'cover' | 'gallery' | 'detail' | 'sku',
      state: String(row.state),
      remoteUrl: nullableString(row.remote_url),
      attempts: Number(row.attempts ?? 0),
      sortOrder: Number(row.sort_order ?? 0)
    }))
  }

  /** 媒体行的重试计数 +1，并记下这次的结果（队列每次尝试后调用）。 */
  recordMediaAttempt(input: { mediaId: string; state: string; failReason: string | null; localPath?: string | null; sha256?: string | null; now?: number }): void {
    const now = input.now ?? Date.now()
    this.db.prepare(`
      UPDATE product_media SET state = ?, fail_reason = ?, attempts = attempts + 1,
             local_path = COALESCE(?, local_path), sha256 = COALESCE(?, sha256)
      WHERE id = ?
    `).run(input.state, input.failReason, input.localPath ?? null, input.sha256 ?? null, input.mediaId)
    void now
  }

  /**
   * 按**图片地址**查已经本地化过的 sha256 与相对路径（跨商品复用）。
   *
   * 为什么需要（2026-09-30 实测）：同一张图常常出现在多个商品上（同款商品的图被多个本地商品引用）。
   * 没有这个映射时，队列会把同一张图**反复下载** —— 实测连着下三遍同一批 22 张，
   * 平台的 CDN 从第三遍开始返回非图片内容（44 张全被判成"格式不支持"而拒绝）。
   * 有映射就能**直接复用本地文件**，一次网络请求都不用发。
   */
  mediaByRemoteUrl(remoteUrl: string): { sha256: string; localPath: string } | null {
    const row = this.db.prepare(`
      SELECT sha256, local_path FROM product_media
      WHERE remote_url = ? AND sha256 IS NOT NULL AND local_path IS NOT NULL
      ORDER BY created_at LIMIT 1
    `).get(remoteUrl) as { sha256: string | null; local_path: string | null } | undefined
    if (!row?.sha256 || !row.local_path) return null
    return { sha256: row.sha256, localPath: row.local_path }
  }

  /** 表里还在引用的本地文件相对路径（保留策略的判据之一）。 */  referencedMediaPaths(): Set<string> {
    const rows = this.db.prepare('SELECT local_path FROM product_media WHERE local_path IS NOT NULL').all() as Array<Record<string, unknown>>
    return new Set(rows.map(row => String(row.local_path)).filter(Boolean))
  }

  /** 按相对路径删媒体行（清理孤儿后同步台账；只删台账，不碰文件）。 */
  deleteMediaByPath(relativePaths: readonly string[]): number {
    if (!relativePaths.length) return 0
    let removed = 0
    const run = this.db.transaction(() => {
      const del = this.db.prepare('DELETE FROM product_media WHERE local_path = ?')
      for (const path of relativePaths) removed += Number(del.run(path).changes ?? 0)
    })
    run()
    return removed
  }

  /** 读某条平台商品链接下的 SKU 映射（界面显示"平台有、本地没有"那三种情况）。 */  listLinkSkus(linkId: string): Array<{ platformSkuId: string; spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null; state: string; variantId: string | null }> {
    const rows = this.db.prepare('SELECT * FROM product_sku_links WHERE link_id = ? ORDER BY platform_sku_id').all(linkId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      platformSkuId: String(row.platform_sku_id),
      spec: parseJsonArray<{ name: string; value: string }>(row.platform_spec_json),
      priceMinor: nullableNumber(row.platform_price_minor),
      stock: nullableNumber(row.platform_stock),
      state: String(row.state),
      variantId: nullableString(row.variant_id)
    }))
  }

  // ------------------------------------------------------------ 发布台账（M3）

  /**
   * 建一次发布任务（一个商品 + 一批店铺 = 一个 job，每店一个 item）。
   *
   * `mode` 只有 `fill` 一种（方案 §7.9：应用里**不提供**"自动提交"开关）——
   * 表上的 CHECK 约束也是这么写的，属于把"不可配置的人工边界"落到 schema 上。
   */
  createPublishJob(input: { productId: string; draftHash: string; batchId?: string | null; now?: number }): string {
    const id = randomUUID()
    const now = input.now ?? Date.now()
    this.db.prepare(`
      INSERT INTO product_publish_jobs (id, product_id, draft_hash, mode, status, batch_id, created_at)
      VALUES (?, ?, ?, 'fill', 'prechecking', ?, ?)
    `).run(id, input.productId, input.draftHash, input.batchId ?? null, now)
    return id
  }

  /** 读一次批量的所有发布项（批量进度面板用）。 */
  listBatchItems(batchId: string): Array<{
    itemId: string; jobId: string; productId: string; storeId: string; tier: string
    status: string; safeMessage: string | null
  }> {
    const rows = this.db.prepare(`
      SELECT i.id AS item_id, i.job_id, j.product_id, i.store_id, i.tier, i.status, i.safe_message
      FROM product_publish_items i
      JOIN product_publish_jobs j ON j.id = i.job_id
      WHERE j.batch_id = ?
      ORDER BY j.created_at, i.updated_at
    `).all(batchId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      itemId: String(row.item_id),
      jobId: String(row.job_id),
      productId: String(row.product_id),
      storeId: String(row.store_id),
      tier: String(row.tier),
      status: String(row.status),
      safeMessage: nullableString(row.safe_message)
    }))
  }

  /** 批量里某个店铺还没开始的项 → 标成 skipped（"跳过这家先做下一家"）。 */
  skipStoreInBatch(input: { batchId: string; storeId: string; now?: number }): number {
    const now = input.now ?? Date.now()
    const result = this.db.prepare(`
      UPDATE product_publish_items SET status = 'skipped', reason_code = 'SKIPPED_BY_USER',
             safe_message = '你选择了跳过这家店（这一条没有提交，之后可以重新发起）', updated_at = ?
      WHERE store_id = ? AND status = 'pending'
        AND job_id IN (SELECT id FROM product_publish_jobs WHERE batch_id = ?)
    `).run(now, input.storeId, input.batchId)
    return Number(result.changes ?? 0)
  }

  /**
   * 「全部暂停」：把批次里**正在跑**的项退回 `pending`。
   *
   * ⚠️ 两件容易写错的事（2026-10-01 实测踩到，见 `@shared/product-status`）：
   *   1. **"正在跑"不叫 `running`** —— 库里真实的名字是 prechecking/filling/fill_partial/verifying；
   *      我最初写成 `in_progress`（一个任何一套命名里都不存在的值）→ 永远命中 0 行、**静默空操作**。
   *   2. **`awaiting_human` 不是"正在跑"** —— 它是人工交接点，暂停批次不该把它冲掉。
   */
  abortBatchInProgress(input: { batchId: string; now?: number }): number {
    const now = input.now ?? Date.now()
    const result = this.db.prepare(`
      UPDATE product_publish_items SET status = 'pending', reason_code = 'ABORTED_BY_USER',
             safe_message = '你暂停了这个批次（这一条没有提交，之后可以重新发起）', updated_at = ?
      WHERE status IN ('prechecking', 'filling', 'fill_partial', 'verifying')
        AND job_id IN (SELECT id FROM product_publish_jobs WHERE batch_id = ?)
    `).run(now, input.batchId)
    return Number(result.changes ?? 0)
  }

  /** 写/更新一个店铺的发布项。`UNIQUE(job_id, store_id)` 保证同店同商品不会有两行（方案 §7.7）。 */
  upsertPublishItem(input: {
    jobId: string
    storeId: string
    tier: 'L1' | 'L2' | 'L3'
    status: string
    filled?: unknown
    manualFieldCount?: number
    platformProductId?: string | null
    reasonCode?: string | null
    safeMessage?: string | null
    evidence?: unknown
    /** 人工门禁对应的任务引擎运行 ID（方案 §7.4） */
    taskRunId?: string
    now?: number
  }): string {
    const now = input.now ?? Date.now()
    const existing = this.db.prepare('SELECT id, evidence_json FROM product_publish_items WHERE job_id = ? AND store_id = ?')
      .get(input.jobId, input.storeId) as { id: string; evidence_json: string | null } | undefined
    if (existing) {
      // `evidence` **没传就保留原有的**（不是清空）。
      // 台账是"一路记下来"的东西：状态更新（如"我已提交"）不该把之前记下的基线擦掉 ——
      // 实测踩到：confirmSubmitted 没带 evidence，把 openHumanGate 记的
      // baselinePlatformProductIds 覆盖成 NULL，回读于是把一切当成"新增"，又变成假阳性。
      // 传了就做**浅合并**（新键覆盖旧键），也不整段替换。
      const merged = input.evidence === undefined
        ? (existing.evidence_json ?? null)
        : mergeEvidence(existing.evidence_json, input.evidence)
      this.db.prepare(`
        UPDATE product_publish_items SET tier = ?, status = ?, filled_json = ?, manual_field_count = ?,
               platform_product_id = ?, reason_code = ?, safe_message = ?, evidence_json = ?, task_run_id = ?, updated_at = ?
        WHERE id = ?
      `).run(input.tier, input.status, jsonOrNull(input.filled), input.manualFieldCount ?? 0,
        input.platformProductId ?? null, input.reasonCode ?? null, input.safeMessage ?? null,
        merged, input.taskRunId ?? null, now, existing.id)
      return existing.id
    }
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO product_publish_items (id, job_id, store_id, tier, status, filled_json, manual_field_count,
                                        platform_product_id, reason_code, safe_message, evidence_json, task_run_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.jobId, input.storeId, input.tier, input.status, jsonOrNull(input.filled),
      input.manualFieldCount ?? 0, input.platformProductId ?? null, input.reasonCode ?? null,
      input.safeMessage ?? null, jsonOrNull(input.evidence), input.taskRunId ?? null, now)
    return id
  }

  setPublishJobStatus(jobId: string, status: string, finishedAt: number | null = null): void {
    this.db.prepare('UPDATE product_publish_jobs SET status = ?, finished_at = ? WHERE id = ?').run(status, finishedAt, jobId)
  }

  /**
   * 找这个商品在这家店的**在途**发布项（预检的"重复发起"判据）。
   *
   * 只认"还没结束"的状态：awaiting_human 也算在途（可以过夜，方案 §7.4）。
   */
  findInflightPublishItem(input: { productId: string; storeId: string }): Record<string, unknown> | null {
    return (this.db.prepare(`
      SELECT i.*, j.product_id, j.draft_hash, j.status AS job_status
      FROM product_publish_items i
      JOIN product_publish_jobs j ON j.id = i.job_id
      WHERE j.product_id = ? AND i.store_id = ?
        AND i.status IN ('prechecking','filling','fill_partial','awaiting_human','verifying')
      ORDER BY i.updated_at DESC LIMIT 1
    `).get(input.productId, input.storeId) as Record<string, unknown> | undefined) ?? null
  }

  /** 发布列表（界面）。 */
  listPublishItems(query: { limit?: number } = {}): Array<Record<string, unknown>> {
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200)
    return this.db.prepare(`
      SELECT i.*, j.product_id, j.draft_hash, j.created_at AS job_created_at, p.title AS product_title
      FROM product_publish_items i
      JOIN product_publish_jobs j ON j.id = i.job_id
      LEFT JOIN products p ON p.id = j.product_id
      ORDER BY i.updated_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>
  }

  /**
   * 该平台/该店上次发布时用的字段值（`product_platform_defaults`）→ 预检里的"用上次选择"。
   *
   * 优先取商品级的，其次平台级默认（表上的 `scope` 就是这么分的）。
   */
  publishDefaults(input: { platform: string; storeId: string; productId: string }): Record<string, string | null> {
    const rows = this.db.prepare(`
      SELECT field_key, field_value, scope FROM product_platform_defaults
      WHERE platform = ? AND (product_id = ? OR product_id IS NULL)
      ORDER BY CASE scope WHEN 'product' THEN 0 ELSE 1 END
    `).all(input.platform, input.productId) as Array<Record<string, unknown>>
    const result: Record<string, string | null> = {}
    // 后面的覆盖前面的 → 商品级优先（ORDER BY 已把它排在前面，所以这里"先写不覆盖"）
    for (const row of rows) {
      const key = String(row.field_key)
      if (!(key in result)) result[key] = nullableString(row.field_value)
    }
    void input.storeId   // 表上没有 store_id 列（默认值是平台级/商品级，不是店铺级）—— 留着参数是为了调用处语义清楚
    return result
  }

  /**
   * 写入一条"平台默认值"（方案 §7.5）。
   *
   * `source` 只有两种：`human_readback`（从人工那一遍回读来的）与 `user_edit`（用户自己在编辑页设的）。
   * **只有用户确认过的建议才会走到这里** —— 规则层只产出建议，不落库。
   */
  savePublishDefault(input: {
    platform: string
    productId: string | null
    fieldKey: string
    fieldValue: string | null
    source: 'human_readback' | 'user_edit'
    now?: number
  }): void {
    const now = input.now ?? Date.now()
    const scope = input.productId ? 'product' : 'platform_default'
    const existing = this.db.prepare(`
      SELECT id FROM product_platform_defaults WHERE platform = ? AND field_key = ?
        AND ((product_id IS NULL AND ? IS NULL) OR product_id = ?)
    `).get(input.platform, input.fieldKey, input.productId, input.productId) as { id: string } | undefined
    if (existing) {
      this.db.prepare(`
        UPDATE product_platform_defaults SET field_value = ?, source = ?, scope = ?, confirmed_at = ?
        WHERE id = ?
      `).run(input.fieldValue, input.source, scope, now, existing.id)
      return
    }
    this.db.prepare(`
      INSERT INTO product_platform_defaults (id, product_id, platform, scope, field_key, field_value, source, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.productId, input.platform, scope, input.fieldKey, input.fieldValue, input.source, now)
  }

  /** 读某平台的必填清单（方案 §7.5 第 3 类）。 */
  listPlatformRequirements(platform: string): Array<{ platform: string; field: string; label: string; observedAt: number }> {
    const rows = this.db.prepare('SELECT * FROM product_platform_requirements WHERE platform = ? ORDER BY field_key')
      .all(platform) as Array<Record<string, unknown>>
    return rows.map(row => ({
      platform: String(row.platform),
      field: String(row.field_key),
      label: String(row.label ?? row.field_key),
      observedAt: Number(row.observed_at ?? 0)
    }))
  }

  /** 记下"平台必填"的字段（观察到的；已存在只更新 label 与 observed_at，**不删旧的**）。 */
  recordPlatformRequirements(input: {
    platform: string
    items: ReadonlyArray<{ field: string; label: string }>
    now?: number
  }): number {
    const now = input.now ?? Date.now()
    let written = 0
    const run = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO product_platform_requirements (id, platform, field_key, label, observed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(platform, field_key) DO UPDATE SET label = excluded.label, observed_at = excluded.observed_at
      `)
      for (const item of input.items) {
        if (!item.field) continue
        upsert.run(randomUUID(), input.platform, item.field, item.label || item.field, now)
        written += 1
      }
    })
    run()
    return written
  }
}

/** 对象转 JSON 字符串；空值返回 null（不写 "undefined" 这种脏数据）。 */
function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try { return JSON.stringify(value) } catch { return null }
}

/**
 * 台账 evidence 的**浅合并**：新键覆盖旧键，旧键保留。
 *
 * 为什么不能整段替换：evidence 是"一路记下来的证据"（基线、回查结果、门禁信息…），
 * 每一步只知道自己那部分；整段替换会让后一步把前一步的证据抹掉（实测踩到过）。
 */
function mergeEvidence(existingJson: string | null, incoming: unknown): string | null {
  let base: Record<string, unknown> = {}
  if (typeof existingJson === 'string' && existingJson) {
    try {
      const parsed = JSON.parse(existingJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>
    } catch { base = {} }
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return jsonOrNull(base)
  return jsonOrNull({ ...base, ...(incoming as Record<string, unknown>) })
}

/** 解析 JSON 数组；坏数据返回空数组（不抛，界面不该因为一行坏数据整页打不开）。 */
function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}
