import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductLibraryService } from '../../apps/desktop/src/main/products/product-library-service'

// 与其它商品测试同一套办法：node:sqlite 跑真实 SQLite（better-sqlite3 是 Electron ABI，纯 Node 下加载不了）。
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

function setup(): { db: SqliteDb; repo: ProductRepository; service: ProductLibraryService } {
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
  const repo = new ProductRepository(shim as never)
  return { db, repo, service: new ProductLibraryService(repo, null) }
}

/** 造一条"已同步"的平台商品（含 v20 的图片 URL 列）。 */
function seedLink(db: SqliteDb, id: string, platformProductId: string, title: string, priceMinor: number, stock: number, imageUrls: string[] = []): void {
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'on_sale', ?, ?, ?, ?, 0, 0)
  `).run(id, PLATFORM, STORE, platformProductId, title, priceMinor, stock, imageUrls.length, JSON.stringify(imageUrls))
}

describe('本地商品库：另存为（本地商品从哪来）', () => {
  realIt('把平台商品另存为本地商品：建出单规格草稿、挂上真实图片地址、并默认归并过去', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '儿童加厚款暖暖套装', 2990, 60000, ['https://mmec.wxqcloud.qq.com.cn/a.jpg'])

    const result = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })

    const product = repo.getProduct(result.productId)!
    expect(product.draft.title).toBe('儿童加厚款暖暖套装')
    // 列表页拿不到 SKU → 单规格占位（不是猜 SKU，是如实建一个待补的规格）
    expect(product.draft.variants).toEqual([{ spec: [], priceMinor: 2990, stock: 60000, skuCode: null }])
    // 图片用同步时采到的真实地址（v20 补的列），不是空的
    expect(product.draft.media).toHaveLength(1)
    expect(product.draft.media[0]).toMatchObject({ role: 'cover', remoteUrl: 'https://mmec.wxqcloud.qq.com.cn/a.jpg', state: 'pending' })
    // 默认归并：平台商品挂到了新建的本地商品上
    expect(repo.listLinks({}).rows[0].productId).toBe(result.productId)
    db.close()
  })

  realIt('没有图片地址时不假装有图（界面会按"没有主图"如实提示）', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '没有图的商品', 100, 1, [])
    const result = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    expect(repo.getProduct(result.productId)!.draft.media).toEqual([])
    expect(result.issues.some(issue => issue.field === 'media' && issue.level === 'blocker')).toBe(true)
    db.close()
  })

  realIt('另存为不存在的平台商品 → 明确抛 LINK_NOT_FOUND（不静默建空商品）', () => {
    const { db, service } = setup()
    expect(() => service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '不存在' })).toThrow('LINK_NOT_FOUND')
    db.close()
  })
})

describe('本地商品库：归并的约束与取消', () => {
  realIt('同一店铺里一个本地商品只能对一个平台商品（防"发重了"被当成两条合法记录）', () => {
    const { db, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1)
    seedLink(db, 'l2', '10002', '商品二', 200, 2)
    const a = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    const b = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10002' })

    // 把 l2 也归到 a 上 → 违反 UNIQUE(store_id, product_id)，必须抛（不吞）
    expect(() => service.merge({ linkId: 'l2', productId: a.productId })).toThrow()
    // 归到自己的 b 上没问题
    expect(() => service.merge({ linkId: 'l2', productId: b.productId })).not.toThrow()
    db.close()
  })

  realIt('取消归并后平台商品回到"未归并"分组，本地商品还在', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1)
    const created = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(0)

    service.unmerge({ linkId: 'l1' })
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(1)
    expect(repo.getProduct(created.productId)).not.toBeNull()   // 本地商品不受影响
    db.close()
  })
})

describe('本地商品库：保存与指纹', () => {
  realIt('保存完整草稿：指纹随内容变化，规格与图片整体替换', () => {
    const { db, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1)
    const created = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })

    const before = service.get({ productId: created.productId })
    const saved = service.save({
      productId: created.productId,
      platform: PLATFORM,
      draft: {
        ...before.draft,
        title: '改过的标题',
        variants: [
          { spec: [{ name: '颜色', value: '红' }], priceMinor: 1290, stock: 5 },
          { spec: [{ name: '颜色', value: '蓝' }], priceMinor: 1390, stock: 3 }
        ]
      }
    })

    expect(saved.draftHash).not.toBe(before.draftHash)      // 内容变了 → 指纹必须变
    const after = service.get({ productId: created.productId })
    expect(after.draft.title).toBe('改过的标题')
    expect(after.draft.variants).toHaveLength(2)
    expect(after.draftHash).toBe(saved.draftHash)
    db.close()
  })

  realIt('保存时返回分级校验：标题超长在微信报 warning，缺主图报 blocker', () => {
    const { db, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1)
    const created = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    const draft = service.get({ productId: created.productId }).draft

    const result = service.save({ productId: created.productId, platform: PLATFORM, draft: { ...draft, title: '一'.repeat(80), media: [] } })
    expect(result.issues.some(issue => issue.field === 'title' && issue.level === 'warning')).toBe(true)
    expect(result.issues.some(issue => issue.field === 'media' && issue.level === 'blocker')).toBe(true)
    db.close()
  })

  realIt('软删：列表里消失，但行还在（硬删会把发布台账级联掉）；平台商品回到"未归并"', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1)
    const created = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    expect(repo.listProducts().total).toBe(1)
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(0)

    service.remove({ productId: created.productId })
    expect(repo.listProducts().total).toBe(0)
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number }).c)).toBe(1)   // 行还在
    // 本地商品既然删了，它的平台商品就没有本地归属了 —— 必须回到"未归并"，
    // 否则界面会继续显示一个已经删掉的商品标题（2026-09-30 UI 验收看到过）
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(1)
    db.close()
  })
})
