import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { inventorySkuServiceFor } from '../../apps/desktop/src/main/products/inventory-sku-service'

type MigrationDb = Parameters<(typeof migrations)[number]['up']>[0]
interface Statement { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }
interface Db { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
type Ctor = new (path: string) => Db

function loadDb(): Ctor | null {
  try { return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: Ctor }).DatabaseSync ?? null } catch { return null }
}

const DbCtor = loadDb()
const realIt = DbCtor ? it : it.skip

function setup(): Db {
  const db = new DbCtor!(':memory:')
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
  db.prepare(`INSERT INTO stores (id,name,platform,admin_url,status,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('store_1', '测试店', '微信小店', 'https://example.invalid', 'online', '#000', 0, 0)
  db.prepare(`INSERT INTO product_platform_links (id,product_id,platform,store_id,platform_product_id,platform_title,platform_status,platform_price_minor,platform_stock,platform_category_path,platform_image_count,platform_image_urls_json,platform_updated_at,first_seen_at,collected_at,raw_snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('link_1', null, '微信小店', 'store_1', 'platform_product_1', '测试商品', 'on_sale', 1990, 10, null, 0, '[]', null, 1, 1000, '{}')
  db.prepare(`INSERT INTO product_sku_links (id,link_id,variant_id,platform_sku_id,platform_spec_json,platform_price_minor,platform_stock,state,collected_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('sku_link_1', 'link_1', null, 'sku_1', JSON.stringify([{ name: '颜色', value: '红' }, { name: '尺寸', value: 'M' }]), 1990, 10, 'active', 1000)
  return db
}

describe('库存价格和 SKU Agent 领域服务', () => {
  realIt('读取本地快照、生成字段级差异并以幂等键记录人工提案', () => {
    const db = setup()
    const service = inventorySkuServiceFor(db as never)
    const collected = service.collect({ storeIds: ['store_1'], productIds: ['platform_product_1'] })
    expect(collected.status).toBe('PARTIAL')
    expect(collected.rows.length).toBe(2)

    const diff = service.diff({ storeId: 'store_1', changes: [{ productId: 'platform_product_1', stock: 20, priceMinor: 2190 }] })
    expect(diff.status).toBe('SUCCEEDED')
    expect(diff.rows[0].diffs.map(item => item.field)).toEqual(['stock', 'priceMinor'])

    const proposal = service.writeback({ domain: 'inventory', storeId: 'store_1', changes: [{ productId: 'platform_product_1', stock: 20, priceMinor: 2190 }], confirmed: false })
    expect(proposal.status).toBe('WAITING_CONFIRMATION')
    expect(proposal.idempotencyKeys[0]).toContain('store_1:微信小店:platform_product_1:')
    service.writeback({ domain: 'inventory', storeId: 'store_1', changes: [{ productId: 'platform_product_1', stock: 20, priceMinor: 2190 }], confirmed: false })
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM commerce_writeback_proposals').get() as { c: number }).c)).toBe(1)
    expect((db.prepare('SELECT side_effect_started,status FROM commerce_writeback_proposals').get() as { side_effect_started: number; status: string })).toEqual({ side_effect_started: 0, status: 'WAITING_CONFIRMATION' })
    db.close()
  })

  realIt('保留多规格 SKU 并拒绝把未实测平台写回伪装成成功', () => {
    const db = setup()
    const service = inventorySkuServiceFor(db as never)
    const diff = service.diff({ storeId: 'store_1', changes: [{ productId: 'platform_product_1', skuId: 'sku_1', spec: [{ name: '颜色', value: '蓝' }, { name: '尺寸', value: 'L' }], stock: 8 }], skuOnly: true })
    expect(diff.rows[0].diffs.some(item => item.field === 'spec')).toBe(true)
    const proposal = service.writeback({ domain: 'sku', storeId: 'store_1', changes: [{ productId: 'platform_product_1', skuId: 'sku_1', spec: [{ name: '颜色', value: '蓝' }, { name: '尺寸', value: 'L' }], stock: 8 }], confirmed: true, confirmationId: 'confirm_test' })
    expect(proposal.status).toBe('NOT_VERIFIED')
    expect(proposal.reasonCode).toBe('PLATFORM_WRITEBACK_NOT_VERIFIED')
    expect(proposal.rows[0].after).toMatchObject({ skuId: 'sku_1', spec: [{ name: '颜色', value: '蓝' }, { name: '尺寸', value: 'L' }] })
    db.close()
  })
})
