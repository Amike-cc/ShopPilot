import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { deriveProductStatus, type LocalProductDraft } from '../../packages/shared/src/product-draft'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductLibraryService } from '../../apps/desktop/src/main/products/product-library-service'

/**
 * v4 重设计 §4.4：商品展示状态由「推导 + 单点重算」维护。
 *
 * 背景（2026-10-15 审查实测）：`products.status` 曾是死字段——INSERT 写死 'draft'、
 * 全代码库零更新点、真实库 152/152 全是 draft。这组测试钉住三件事：
 *   ① 推导规则本身；② 写路径确实调用了重算（源码级扫描，防回归成死字段）；
 *   ③ 恢复（回收站）之后状态被重算。
 */

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

function seedLink(db: SqliteDb, id: string, platformProductId: string, title: string, priceMinor: number, stock: number, imageUrls: string[] = []): void {
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'on_sale', ?, ?, ?, ?, 0, 0)
  `).run(id, PLATFORM, STORE, platformProductId, title, priceMinor, stock, imageUrls.length, JSON.stringify(imageUrls))
}

/** 一份"无阻断"的草稿：有封面、有带价的规格。 */
function readyDraft(overrides: Partial<LocalProductDraft> = {}): LocalProductDraft {
  return {
    title: '测试商品',
    variants: [{ spec: [{ name: '颜色', value: '红' }], priceMinor: 990, stock: 5 }],
    media: [{ role: 'cover', state: 'localized', remoteUrl: 'https://example.com/a.jpg' }],
    ...overrides
  }
}

describe('deriveProductStatus（纯规则）', () => {
  it('无阻断 → ready；有 blocker → draft；archived 显式覆盖一切', () => {
    expect(deriveProductStatus([])).toBe('ready')
    expect(deriveProductStatus([{ level: 'warning', field: 'title', message: 'w' }])).toBe('ready')
    expect(deriveProductStatus([{ level: 'blocker', field: 'media', message: '没有主图' }])).toBe('draft')
    expect(deriveProductStatus([{ level: 'blocker', field: 'media', message: '没有主图' }], { archived: true })).toBe('archived')
  })
})

describe('状态重算：写路径落地（真实 SQLite）', () => {
  realIt('另存为：有图 → ready；没图（blocker）→ draft——不再是"永远 draft"', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '有图的商品', 2990, 10, ['https://example.com/a.jpg'])
    seedLink(db, 'l2', '10002', '没图的商品', 1990, 10, [])

    const withImage = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    const withoutImage = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10002' })

    expect(repo.getProduct(withImage.productId)!.status).toBe('ready')
    expect(repo.getProduct(withoutImage.productId)!.status).toBe('draft')
    db.close()
  })

  realIt('保存补齐内容后：draft → ready；archived 是显式态、保存不覆盖它', () => {
    const { db, repo, service } = setup()
    const id = repo.createProduct({ draft: { title: '缺图的商品', variants: [{ spec: [], priceMinor: 500, stock: 1 }], media: [] }, draftHash: 'h1' })
    expect(repo.getProduct(id)!.status).toBe('draft') // 直插的初始值

    service.save({ productId: id, platform: PLATFORM, draft: readyDraft() })
    expect(repo.getProduct(id)!.status).toBe('ready') // 保存后按内容重算

    repo.setProductStatus(id, 'archived')
    service.save({ productId: id, platform: PLATFORM, draft: readyDraft({ title: '改过标题' }) })
    expect(repo.getProduct(id)!.status).toBe('archived') // 归档不被重算冲掉
    db.close()
  })

  realIt('恢复：软删 → 回收站可见 → 恢复后状态按内容重算、不自动重挂归并（D2）', () => {
    const { db, repo, service } = setup()
    seedLink(db, 'l1', '10001', '商品一', 100, 1, ['https://example.com/a.jpg'])
    const created = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001' })
    expect(repo.getProduct(created.productId)!.status).toBe('ready')

    service.remove({ productId: created.productId })
    expect(repo.getProduct(created.productId)).toBeNull() // 主列表不可见
    const trash = repo.listTrash({})
    expect(trash.total).toBe(1)
    expect(trash.rows[0].id).toBe(created.productId)
    expect(trash.rows[0].publishJobCount).toBe(0)

    // 软删时平台商品被放回"未归并"（原有语义不变）
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(1)

    const restored = service.restore({ productIds: [created.productId] })
    expect(restored.restored).toBe(1)
    expect(repo.listTrash({}).total).toBe(0)
    expect(repo.getProduct(created.productId)!.status).toBe('ready')
    expect(repo.listLinks({ onlyOrphan: true }).total).toBe(1) // 不自动重挂
    db.close()
  })

  realIt('回填：recomputeAllStatuses 把直插的 draft 按内容纠正为 ready（幂等）', () => {
    const { db, repo, service } = setup()
    const id = repo.createProduct({ draft: readyDraft({ title: 'A' }), draftHash: 'h1' })
    expect(repo.getProduct(id)!.status).toBe('draft') // 直插未重算

    const first = service.recomputeAllStatuses()
    expect(first.checked).toBe(1)
    expect(first.changed).toBe(1)
    expect(repo.getProduct(id)!.status).toBe('ready')

    const second = service.recomputeAllStatuses()
    expect(second.changed).toBe(0) // 幂等
    db.close()
  })
})

describe('防死字段回归（源码级扫描）', () => {
  const read = (p: string) => readFileSync(resolve(p), 'utf8')
  const serviceSrc = read('apps/desktop/src/main/products/product-library-service.ts')
  const repo = read('apps/desktop/src/main/products/product-repository.ts')

  it('所有写路径都调用单点重算：save / saveAsLocal / restore / 回填', () => {
    const calls = serviceSrc.match(/this\.recomputeStatus\(/g) || []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(serviceSrc).toContain('backfillProductStatusesIfNeeded')
    expect(serviceSrc).toContain("product.status_backfill_v4")
    expect(repo).toContain('setProductStatus')
  })

  it('启动段挂了协议登记、协议 handler 与状态回填', () => {
    const index = read('apps/desktop/src/main/index.ts')
    expect(index).toContain('registerProductMediaScheme()')
    expect(index).toContain('registerProductMediaProtocol()')
    expect(index).toContain('backfillProductStatusesIfNeeded()')
  })

  it('图片协议只暴露白名单扩展名与根内路径', () => {
    const protocol = read('apps/desktop/src/main/products/product-media-protocol.ts')
    expect(protocol).toContain("url.hostname !== 'local'")
    expect(protocol).toContain('ALLOWED_EXT')
    expect(protocol).toContain('startsWith(rootWithSep)')
  })
})
