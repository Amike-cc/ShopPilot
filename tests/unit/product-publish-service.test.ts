import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductPublishService } from '../../apps/desktop/src/main/products/product-publish-service'
import type { LocalProductDraft } from '@shared/product-draft'
import { localProductDraftHash } from '@shared/product-draft'

type MigrationDb = Parameters<(typeof migrations)[number]['up']>[0]
interface SqliteStatement { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
type SqliteCtor = new (path: string) => SqliteDb

function loadSqlite(): SqliteCtor | null {
  try {
    const require_ = createRequire(import.meta.url)
    return (require_('node:sqlite') as { DatabaseSync?: SqliteCtor }).DatabaseSync ?? null
  } catch { return null }
}

const DatabaseSyncCtor = loadSqlite()
const realIt = DatabaseSyncCtor ? it : it.skip

const SOURCE_STORE = 'store_source'
const TARGET_STORE = 'store_target'

function setup(): { db: SqliteDb; repo: ProductRepository; service: ProductPublishService; productId: string } {
  const db = new DatabaseSyncCtor!(':memory:')
  const shim = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      db.exec('BEGIN')
      try { const result = fn(...args); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
    }
  }
  migrate(shim as unknown as MigrationDb)
  for (const [id, name] of [[SOURCE_STORE, '来源店铺'], [TARGET_STORE, '目标店铺']]) {
    db.prepare(`
      INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, created_at, updated_at)
      VALUES (?, ?, '微信小店', 'https://store.weixin.qq.com/shop/home', 'online', '#000', 0, 0)
    `).run(id, name)
  }

  const repo = new ProductRepository(shim as never)
  const draft: LocalProductDraft = {
    title: '跨店测试商品',
    subtitle: null,
    description: '测试详情',
    brand: '测试品牌',
    localCategory: '测试类目',
    tags: [],
    variants: [{ spec: [], priceMinor: 1290, stock: 5, skuCode: 'SKU-1', barcode: '69000001' }],
    media: [{ role: 'cover', state: 'pending', remoteUrl: 'https://example.com/cover.jpg' }]
  }
  const productId = repo.createProduct({ draft, draftHash: localProductDraftHash(draft), sourceLinkId: null })
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES ('source-link', ?, '微信小店', ?, '10001', '跨店测试商品', 'on_sale', 1290, 5, 1, ?, 0, 0)
  `).run(productId, SOURCE_STORE, JSON.stringify(['https://example.com/cover.jpg']))

  const service = new ProductPublishService({
    getStore: storeId => {
      if (storeId === SOURCE_STORE) return { id: SOURCE_STORE, name: '来源店铺', platform: '微信小店', status: 'online' } as never
      if (storeId === TARGET_STORE) return { id: TARGET_STORE, name: '目标店铺', platform: '微信小店', status: 'online' } as never
      return null
    },
    waitForStoreWebContents: async () => null,
    openStorePage: () => undefined,
    createTab: () => 'tab',
    getTabWebContents: () => null,
    closeTab: () => undefined,
    repository: repo
  })
  return { db, repo, service, productId }
}

describe('跨店上传批次门禁', () => {
  realIt('全部 (商品,店铺) 对都已存在时由主进程拒绝（整单重复，无剩余项）', () => {
    const { db, service, productId } = setup()
    const result = service.createBatch({ productIds: [productId], storeIds: [SOURCE_STORE] })

    expect(result.ok).toBe(false)
    expect(result.batchId).toBeNull()
    expect(result.errors.join('')).toContain('无需重复上传')
    expect((db.prepare('SELECT COUNT(*) AS c FROM product_publish_jobs').get() as { c: number }).c).toBe(0)
    db.close()
  })

  realIt('部分重叠：已挂载的 (商品,店铺) 对被剔除，其余照常建批、不整单拒绝（审查 P1-1）', () => {
    const { db, repo, service, productId } = setup()
    // 第二个商品：没有来源店的平台归并记录
    const draft2: LocalProductDraft = {
      title: '跨店测试商品二号',
      subtitle: null,
      description: '测试详情二',
      brand: '测试品牌',
      localCategory: '测试类目',
      tags: [],
      variants: [{ spec: [], priceMinor: 990, stock: 3, skuCode: 'SKU-2', barcode: '69000002' }],
      media: [{ role: 'cover', state: 'pending', remoteUrl: 'https://example.com/cover2.jpg' }]
    }
    const productId2 = repo.createProduct({ draft: draft2, draftHash: localProductDraftHash(draft2), sourceLinkId: null })

    const result = service.createBatch({ productIds: [productId, productId2], storeIds: [SOURCE_STORE] })

    // 旧实现（整单拒绝）会在这里 ok:false——修复后剔重继续，只有剩余项入批
    expect(result.ok).toBe(true)
    expect(result.batchId).toBeTruthy()
    expect(result.progress).toMatchObject({ total: 1, pending: 1, done: 0, waitingHuman: 0, failed: 0 })
    expect((db.prepare('SELECT COUNT(*) AS c FROM product_publish_jobs').get() as { c: number }).c).toBe(1)
    db.close()
  })

  realIt('目标店铺没有原店归并时可以建立待人工批次', () => {
    const { db, service, productId } = setup()
    const result = service.createBatch({ productIds: [productId], storeIds: [TARGET_STORE] })

    expect(result.ok).toBe(true)
    expect(result.batchId).toBeTruthy()
    expect(result.progress).toMatchObject({ total: 1, pending: 1, done: 0, waitingHuman: 0, failed: 0 })
    expect((db.prepare('SELECT COUNT(*) AS c FROM product_publish_jobs').get() as { c: number }).c).toBe(1)
    db.close()
  })
})

