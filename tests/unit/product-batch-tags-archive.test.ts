import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductLibraryService } from '../../apps/desktop/src/main/products/product-library-service'
import { ProductBatchService } from '../../apps/desktop/src/main/products/product-batch-service'
import { mergeProductTags, removeProductTags } from '../../packages/shared/src/product-batch'

/**
 * v4 重设计 §3.5 R3：批量标签与归档（测试清单 9.2：标签合并去重、归档/恢复幂等）。
 * 批量服务是"循环调用 library 单点写路径"——这里重点钉：去重语义、幂等、审计计数。
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

function setup(): { db: SqliteDb; repo: ProductRepository; service: ProductLibraryService; batch: ProductBatchService } {
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
  const service = new ProductLibraryService(repo, null)
  return { db, repo, service, batch: new ProductBatchService(repo, service) }
}

function seedLink(db: SqliteDb, id: string, platformProductId: string, title: string): void {
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'on_sale', 12900, 34, 0, '[]', 0, 0)
  `).run(id, PLATFORM, STORE, platformProductId, title)
}

function makeProducts(db: SqliteDb, service: ProductLibraryService, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    seedLink(db, `link_${index}`, String(10000 + index), `批量测试商品 ${index}`)
    ids.push(service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: String(10000 + index), mergeLink: true }).productId)
  }
  return ids
}

describe('批量标签：纯函数语义', () => {
  it('合并去重、不改其他标签、超过上限截断新增', () => {
    expect(mergeProductTags(['清仓'], ['清仓', '下架']).tags).toEqual(['清仓', '下架'])
    expect(mergeProductTags(['a', 'b'], ['c']).added).toEqual(['c'])
    const limited = mergeProductTags(['1', '2', '3'], ['4', '5', '6'], 4)
    expect(limited.tags.length).toBe(4)
    expect(limited.added).toEqual(['4'])
  })
  it('删除只删命中的', () => {
    expect(removeProductTags(['a', 'b', 'c'], ['b', 'x']).tags).toEqual(['a', 'c'])
    expect(removeProductTags(['a'], ['x']).removed).toEqual([])
  })
})

realIt('批量加标签 / 删标签：去重合并不改其他字段；无变化如实跳过；上限 500', async () => {
  const { db, service, batch } = setup()
  const ids = makeProducts(db, service, 3)
  const preview = batch.preview({ operation: 'tags.add', productIds: ids, params: { tags: ['清仓', '下架'] } })
  expect(preview.affected).toBe(3)
  const outcome = await batch.execute({ operation: 'tags.add', productIds: ids, params: { tags: ['清仓', '下架'] } })
  expect(outcome.succeeded).toBe(3)
  for (const id of ids) {
    const product = service.get({ productId: id })
    expect(product.draft.tags).toContain('清仓')
    expect(product.draft.tags).toContain('下架')
    expect(product.draft.title).toContain('批量测试商品') // 其他字段不动
  }
  // 再加一次：全部"无变化"跳过（幂等）
  const again = await batch.execute({ operation: 'tags.add', productIds: ids, params: { tags: ['清仓', '下架'] } })
  expect(again.succeeded).toBe(0)
  expect(again.skipped.length).toBe(3)
  // 删标签
  const removed = await batch.execute({ operation: 'tags.remove', productIds: [ids[0]], params: { tags: ['清仓'] } })
  expect(removed.succeeded).toBe(1)
  expect(service.get({ productId: ids[0] }).draft.tags).not.toContain('清仓')
  // 超上限拒绝（500）
  const many = Array.from({ length: 501 }, (_, index) => `id_${index}`)
  expect(() => batch.preview({ operation: 'tags.add', productIds: many, params: { tags: ['x'] } })).toThrow('BATCH_LIMIT_EXCEEDED')
})

realIt('批量归档/取消归档：幂等（重复归档进 skipped）；取消归档重算回推导值', async () => {
  const { db, service, batch } = setup()
  const ids = makeProducts(db, service, 2)
  expect((await batch.execute({ operation: 'archive', productIds: ids })).succeeded).toBe(2)
  for (const id of ids) expect(service.get({ productId: id }).status).toBe('archived')
  // 再归档一次：幂等跳过
  const again = await batch.execute({ operation: 'archive', productIds: ids })
  expect(again.succeeded).toBe(0)
  expect(again.skipped.length).toBe(2)
  // 取消归档：按内容重算（占位单规格有价格 → 仍缺主图 → draft）
  expect((await batch.execute({ operation: 'unarchive', productIds: ids })).succeeded).toBe(2)
  for (const id of ids) expect(service.get({ productId: id }).status).toBe('draft')
})

realIt('批量删除：软删进回收站（可恢复）', async () => {
  const { db, service, batch } = setup()
  const ids = makeProducts(db, service, 2)
  const outcome = await batch.execute({ operation: 'delete', productIds: ids })
  expect(outcome.succeeded).toBe(2)
  for (const id of ids) {
    const raw = db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(id) as { deleted_at: number | null }
    expect(raw.deleted_at).not.toBeNull()
  }
})

realIt('批量改价：-10% 四舍五入；null 价格变体跳过（不当 0）；保存后指纹变化', async () => {
  const { db, service, batch } = setup()
  const ids = makeProducts(db, service, 1)
  const id = ids[0]
  // 造一个 null 价格变体（价格未取到的形态）
  db.prepare(`INSERT INTO product_variants (id, product_id, spec_json, sku_code, price_minor, stock, sort_order, created_at, updated_at)
              VALUES ('v_null', ?, '[{"name":"颜色","value":"黑"}]', NULL, NULL, NULL, 5, 0, 0)`).run(id)
  const hashBefore = service.get({ productId: id }).draftHash
  const preview = batch.preview({ operation: 'price', productIds: [id], params: { mode: 'percent', value: -10 } })
  expect(preview.affected).toBe(1)
  expect(preview.sample[0].detail).toContain('¥')
  const outcome = await batch.execute({ operation: 'price', productIds: [id], params: { mode: 'percent', value: -10 } })
  expect(outcome.succeeded).toBe(1)
  const after = service.get({ productId: id })
  expect(after.draftHash).not.toBe(hashBefore) // 价格变了 → 指纹变（发布预检会如实提示）
  const nulls = after.draft.variants.filter(variant => variant.priceMinor == null)
  expect(nulls.length).toBe(1) // null 仍是 null
  const priced = after.draft.variants.find(variant => variant.priceMinor != null)
  expect(priced?.priceMinor).toBe(Math.round(12900 * 0.9))
})