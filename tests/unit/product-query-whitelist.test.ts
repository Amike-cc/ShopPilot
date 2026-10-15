import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import {
  PRODUCT_LIBRARY_STATUSES,
  productLibraryListQuerySchema,
  productLibraryRestoreInputSchema,
  productLibraryTrashListQuerySchema,
  productListQuerySchema
} from '../../packages/shared/src/schemas/product'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'

/**
 * v4 重设计 §4.2/§4.3/§4.5：查询扩展（筛选 / 排序白名单 / 分页）与回收站。
 *
 * 两层钉住：
 *   ① Schema 层——入参白名单（未知排序/状态必须被拒，strict 拒多余字段）；
 *   ② 仓储层——真实 SQLite 上的筛选组合、排序方向、NULL 排最后、聚合列。
 */

type MigrationDb = Parameters<(typeof migrations)[number]['up']>[0]
interface SqliteStatement { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
type SqliteCtor = new (path: string) => SqliteDb
function loadSqlite(): SqliteCtor | null {
  try { const require_ = createRequire(import.meta.url); return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null } catch { return null }
}
const DatabaseSyncCtor = loadSqlite()
const realIt = DatabaseSyncCtor ? it : it.skip

const STORE = 'store_a'
const PLATFORM = '微信小店'

function setup(): { db: SqliteDb; repo: ProductRepository } {
  const db = new DatabaseSyncCtor!(':memory:')
  const shim = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      db.exec('BEGIN')
      try { const r = fn(...args); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }
  migrate(shim as unknown as MigrationDb)
  db.prepare(`
    INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, created_at, updated_at)
    VALUES (?, '微信小店测试', ?, 'https://store.weixin.qq.com/shop/home', 'online', '#000', 0, 0)
  `).run(STORE, PLATFORM)
  return { db, repo: new ProductRepository(shim as never) }
}

function seedLink(db: SqliteDb, id: string, platformProductId: string, title: string, priceMinor: number | null, status = 'on_sale', collectedAt = 0): void {
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, '[]', 0, ?)
  `).run(id, PLATFORM, STORE, platformProductId, title, status, priceMinor, collectedAt)
}

describe('查询入参白名单（Schema 层）', () => {
  it('本地列表：接受筛选/排序/分页组合', () => {
    const parsed = productLibraryListQuerySchema.safeParse({
      keyword: '沙发', status: ['ready', 'draft'], linked: 'linked', platform: '微信小店',
      sort: 'priceMin', order: 'asc', limit: 50, offset: 0
    })
    expect(parsed.success).toBe(true)
  })

  it('本地列表：未知排序 / 未知状态 / 未知挂载 / 多余字段一律拒绝', () => {
    expect(productLibraryListQuerySchema.safeParse({ sort: 'evil' }).success).toBe(false)
    expect(productLibraryListQuerySchema.safeParse({ status: ['evil'] }).success).toBe(false)
    expect(productLibraryListQuerySchema.safeParse({ linked: 'evil' }).success).toBe(false)
    expect(productLibraryListQuerySchema.safeParse({ whatever: 1 }).success).toBe(false)
    expect(PRODUCT_LIBRARY_STATUSES).toEqual(['draft', 'ready', 'archived'])
  })

  it('平台列表：接受平台状态与排序白名单；拒绝未知值', () => {
    expect(productListQuerySchema.safeParse({ platformStatus: 'on_sale', sort: 'price', order: 'desc' }).success).toBe(true)
    expect(productListQuerySchema.safeParse({ platformStatus: 'evil' }).success).toBe(false)
    expect(productListQuerySchema.safeParse({ sort: 'evil' }).success).toBe(false)
  })

  it('回收站与恢复：数量上限 100、空数组拒绝', () => {
    expect(productLibraryTrashListQuerySchema.safeParse({ keyword: 'x', limit: 50, offset: 0 }).success).toBe(true)
    expect(productLibraryRestoreInputSchema.safeParse({ productIds: ['p1'] }).success).toBe(true)
    expect(productLibraryRestoreInputSchema.safeParse({ productIds: [] }).success).toBe(false)
    expect(productLibraryRestoreInputSchema.safeParse({ productIds: Array.from({ length: 101 }, (_, i) => `p${i}`) }).success).toBe(false)
  })
})

describe('仓储查询：本地商品（真实 SQLite）', () => {
  function seedProducts(): { db: SqliteDb; repo: ProductRepository; p1: string; p2: string; p3: string } {
    const { db, repo } = setup()
    const p1 = repo.createProduct({
      draft: {
        title: '真皮沙发',
        variants: [
          { spec: [{ name: '颜色', value: '黑' }], priceMinor: 10000, stock: 5, skuCode: 'SOFA-1' },
          { spec: [{ name: '颜色', value: '白' }], priceMinor: 20000, stock: 3, skuCode: 'SOFA-2' }
        ],
        media: []
      }, draftHash: 'h1'
    })
    const p2 = repo.createProduct({
      draft: { title: '实木椅子', variants: [{ spec: [], priceMinor: 5000, stock: 0 }], media: [] }, draftHash: 'h2'
    })
    const p3 = repo.createProduct({ draft: { title: '大理石桌', variants: [], media: [] }, draftHash: 'h3' })
    repo.setProductStatus(p1, 'ready')
    repo.setProductStatus(p2, 'draft')
    repo.setProductStatus(p3, 'archived')
    // p1 的封面已本地化（列表要给缩略图路径）
    db.prepare(`
      INSERT INTO product_media (id, product_id, role, origin, state, local_path, sha256, created_at)
      VALUES ('m1', ?, 'cover', 'platform', 'localized', 'ab/deadbeef.webp', ?, 0)
    `).run(p1, 'a'.repeat(64))
    // p1 挂到一个平台商品上
    seedLink(db, 'l1', '10001', '沙发（平台侧）', 10000)
    repo.mergeLink('l1', p1)
    return { db, repo, p1, p2, p3 }
  }

  realIt('筛选：关键词命中 SKU 码 / 状态 / 挂载 / 平台 四类组合', () => {
    const { db, repo, p1, p2, p3 } = seedProducts()
    expect(repo.listProducts({}).total).toBe(3)
    // 关键词命中 SKU 码（v4 §4.5 多字段搜索）
    const bySku = repo.listProducts({ keyword: 'SOFA' })
    expect(bySku.total).toBe(1)
    expect(bySku.rows[0].id).toBe(p1)
    expect(repo.listProducts({ keyword: '椅' }).rows[0].id).toBe(p2)
    // 状态筛选
    expect(repo.listProducts({ status: ['archived'] }).rows[0].id).toBe(p3)
    // 挂载筛选
    expect(repo.listProducts({ linked: 'linked' }).total).toBe(1)
    expect(repo.listProducts({ linked: 'unlinked' }).total).toBe(2)
    // 平台筛选
    expect(repo.listProducts({ platform: PLATFORM }).rows[0].id).toBe(p1)
    db.close()
  })

  realIt('排序：价格升序 NULL 排最后；聚合列正确（价格区间/库存合计/挂载平台/封面路径）', () => {
    const { db, repo, p1, p2, p3 } = seedProducts()
    const asc = repo.listProducts({ sort: 'priceMin', order: 'asc' })
    expect(asc.rows.map(row => row.id)).toEqual([p2, p1, p3]) // 5000 → 10000 → null 最后
    const byStock = repo.listProducts({ sort: 'stockTotal', order: 'desc' })
    expect(byStock.rows.map(row => row.id)).toEqual([p1, p2, p3]) // 8 → 0 → null 最后

    const rowP1 = repo.listProducts({}).rows.find(row => row.id === p1)!
    expect(rowP1).toMatchObject({
      variantCount: 2, priceMin: 10000, priceMax: 20000, stockTotal: 8,
      platforms: [PLATFORM], coverLocalPath: 'ab/deadbeef.webp'
    })
    const rowP3 = repo.listProducts({}).rows.find(row => row.id === p3)!
    expect(rowP3.priceMin).toBeNull()
    expect(rowP3.stockTotal).toBeNull()
    expect(rowP3.platforms).toEqual([])
    db.close()
  })

  realIt('回收站：软删可见、恢复后回到主列表', () => {
    const { db, repo, p2 } = seedProducts()
    repo.softDeleteProduct(p2)
    expect(repo.listProducts({}).total).toBe(2)
    const trash = repo.listTrash({})
    expect(trash.total).toBe(1)
    expect(trash.rows[0]).toMatchObject({ id: p2, publishJobCount: 0 })
    expect(repo.restoreProducts([p2])).toBe(1)
    expect(repo.listTrash({}).total).toBe(0)
    expect(repo.listProducts({}).total).toBe(3)
    db.close()
  })
})

describe('仓储查询：平台商品（真实 SQLite）', () => {
  realIt('平台状态 / 只看未归并 / 关键词前缀 / 排序（NULL 最后、未知排序回退）', () => {
    const { db, repo } = setup()
    seedLink(db, 'l1', '10001', '在售已归并', 10000, 'on_sale', 1)
    seedLink(db, 'l2', '20001', '下架未归并', 5000, 'off_shelf', 2)
    seedLink(db, 'l3', '20002', '在售未归并无价', null, 'on_sale', 3)
    // l1 归并到一个本地商品上 → 未归并只剩 l2 / l3
    const target = repo.createProduct({ draft: { title: '归并目标', variants: [], media: [] }, draftHash: 'h0' })
    repo.mergeLink('l1', target)

    expect(repo.listLinks({ platformStatus: 'on_sale' }).total).toBe(2)
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(2)
    // 平台商品 ID 前缀命中
    expect(repo.listLinks({ keyword: '200' }).total).toBe(2)

    // 价格升序：5000 → 10000 → null 最后
    const asc = repo.listLinks({ sort: 'price', order: 'asc' })
    expect(asc.rows.map(row => row.linkId)).toEqual(['l2', 'l1', 'l3'])
    // 默认排序（采集时间倒序）
    expect(repo.listLinks({}).rows.map(row => row.linkId)).toEqual(['l3', 'l2', 'l1'])
    // 未知排序回退默认（白名单外的值不拼 SQL）
    const fallback = repo.listLinks({ sort: 'bogus' as never })
    expect(fallback.rows.map(row => row.linkId)).toEqual(['l3', 'l2', 'l1'])
    db.close()
  })
})
