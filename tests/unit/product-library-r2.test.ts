import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductLibraryService } from '../../apps/desktop/src/main/products/product-library-service'

/**
 * v4 重设计 §3.1/§3.3/§3.4 R2：增删改闭环。
 *
 * 钉住 DoD 的四条路径：
 *   ① 新建空白商品（创建即可编辑；状态如实为草稿、校验如实报缺失）；
 *   ② 复制（媒体文件 sha256 复用——行引用同一 local_path，绝无第二份文件；发布记录不复制）；
 *   ③ 归档流转（archived 是显式态；取消归档按内容重算）；
 *   ④ 彻底删除（无发布记录才可；级联行删除 + 链接回「未归并」；有发布记录则拒绝）。
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

function seedLinkWithImage(db: SqliteDb, id: string, platformProductId: string, title: string, imageUrl: string): void {
  db.prepare(`
    INSERT INTO product_platform_links (
      id, product_id, platform, store_id, platform_product_id, platform_title, platform_status,
      platform_price_minor, platform_stock, platform_image_count, platform_image_urls_json,
      first_seen_at, collected_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'on_sale', 12900, 34, 1, ?, 0, 0)
  `).run(id, PLATFORM, STORE, platformProductId, title, JSON.stringify([imageUrl]))
}

function mediaRows(db: SqliteDb, productId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM product_media WHERE product_id = ? ORDER BY sort_order').all(productId) as Array<Record<string, unknown>>
}

realIt('新建空白商品：默认标题、状态草稿、校验如实报缺（没有主图/没有规格）', () => {
  const { service } = setup()
  const created = service.createBlank({})
  expect(created.status).toBe('draft')
  const levels = created.issues.map(issue => issue.level)
  expect(levels).toContain('blocker')
  expect(created.issues.some(issue => /主图/.test(issue.message))).toBe(true)
  const read = service.get({ productId: created.productId })
  expect(read.draft.title).toBe('未命名商品')
  // 自定义标题也通
  const named = service.createBlank({ title: '自定义标题' })
  expect(service.get({ productId: named.productId }).draft.title).toBe('自定义标题')
})

realIt('复制：标题加「（副本）」；媒体行 sha256/local_path 原样复用（不复制文件）；发布记录不跟着复制；指纹按新内容重算', () => {
  const { db, repo, service } = setup()
  seedLinkWithImage(db, 'link_1', '10001', '真皮沙发', 'https://img.example.com/sofa.jpg')
  const saved = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001', mergeLink: true })
  const sourceId = saved.productId
  // 模拟平台图已本地化（replaceMedia 落的行带 local_path/sha256）
  // 补成**多行**再复制：第二张媒体行 + 第二条规格（多行复制是 2026-10-16 真机炸过的场景：
  // INSERT...SELECT 常量 id 让每行主键相同 → UNIQUE constraint failed）
  db.prepare(`UPDATE product_media SET local_path = 'ab/abcdef.jpg', sha256 = 'abcdef', state = 'localized' WHERE product_id = ?`).run(sourceId)
  db.prepare(`UPDATE products SET draft_hash = 'hash_source' WHERE id = ?`).run(sourceId)
  db.prepare(`
    INSERT INTO product_media (id, product_id, role, origin, remote_url, local_path, sha256, state, sort_order, created_at)
    VALUES ('m_extra', ?, 'gallery', 'platform', 'https://img.example.com/sofa-2.jpg', 'cd/cd1234.jpg', 'cd1234', 'localized', 1, 0)
  `).run(sourceId)
  db.prepare(`
    INSERT INTO product_variants (id, product_id, spec_json, sku_code, price_minor, stock, sort_order, created_at, updated_at)
    VALUES ('v_extra', ?, '[{"name":"颜色","value":"黑"}]', 'SKU-B', 15900, 12, 1, 0, 0)
  `).run(sourceId)
  // 源商品来一条发布记录（验证"记录绝不复制"）
  db.prepare(`INSERT INTO product_publish_jobs (id, product_id, draft_hash, mode, status, created_at) VALUES ('job_1', ?, 'hash_source', 'fill', 'succeeded', 0)`).run(sourceId)

  const duplicated = service.duplicate({ productId: sourceId })
  expect(duplicated.productId).not.toBe(sourceId)
  expect(duplicated.draftHash).not.toBe('hash_source') // 按新内容重算（DoD：指纹一致）

  const sourceMedia = mediaRows(db, sourceId)
  const copyMedia = mediaRows(db, duplicated.productId)
  expect(sourceMedia.length).toBe(2)
  expect(copyMedia.length).toBe(2)
  const copyIds = new Set(copyMedia.map(row => String(row.id)))
  expect(copyIds.size).toBe(2) // 每行 id 唯一（多行复制的回归钉）
  // sha256 复用断言：逐行 local_path/sha256 相同 = 磁盘上还是同一份文件
  const sourceBySha = new Map(sourceMedia.map(row => [String(row.sha256), row]))
  for (const row of copyMedia) {
    const source = sourceBySha.get(String(row.sha256))
    expect(source).toBeDefined()
    // 显式窄化：断言存在不等于类型上一定存在（缺失时下面这行会读出 undefined 而误判）
    if (!source) throw new Error(`复制行的 sha256 在源媒体里找不到：${String(row.sha256)}`)
    expect(row.local_path).toBe(source.local_path)
  }
  const copy = repo.getProduct(duplicated.productId)
  expect(copy?.draft.title.endsWith('（副本）')).toBe(true)
  expect(copy?.sourceLinkId).toBeNull() // 复制品不是"另存"来的
  expect(copy?.draft.variants.length).toBe(2) // 规格也逐行复制
  // 发布记录只属于源商品
  const copyJobs = db.prepare('SELECT COUNT(*) AS c FROM product_publish_jobs WHERE product_id = ?').get(duplicated.productId) as { c: number }
  expect(Number(copyJobs.c)).toBe(0)
})

realIt('归档是显式态：归档后 save 重算不覆盖；取消归档按内容重算回推导值', () => {
  const { service } = setup()
  const created = service.createBlank({})
  expect(service.setArchived({ productId: created.productId, archived: true }).status).toBe('archived')
  // 归档态下保存（有 blocker 也会被重算覆盖回去吗？——不会，重算尊重显式 archived）
  const afterSave = service.save({ productId: created.productId, draft: { title: '改名也不解归档', subtitle: null, description: null, brand: null, localCategory: null, tags: [], variants: [], media: [] } })
  expect(afterSave.status).toBe('archived')
  // 取消归档：按内容重算（内容还是空 → 草稿）
  expect(service.setArchived({ productId: created.productId, archived: false }).status).toBe('draft')
})

realIt('彻底删除：无发布记录才可；级联行删除、链接回「未归并」；有发布记录则拒绝', () => {
  const { db, repo, service } = setup()
  seedLinkWithImage(db, 'link_1', '10001', '要被彻底删的', 'https://img.example.com/a.jpg')
  const saved = service.saveAsLocal({ platform: PLATFORM, storeId: STORE, platformProductId: '10001', mergeLink: true })
  const id = saved.productId
  db.prepare(`UPDATE product_media SET local_path = 'ab/abcdef.jpg', sha256 = 'abcdef', state = 'localized' WHERE product_id = ?`).run(id)

  // 有发布记录 → 拒绝
  db.prepare(`INSERT INTO product_publish_jobs (id, product_id, draft_hash, mode, status, created_at) VALUES ('job_1', ?, 'h', 'fill', 'succeeded', 0)`).run(id)
  expect(() => service.purge({ productId: id })).toThrow('PRODUCT_HAS_PUBLISH_RECORDS')
  expect(repo.getProduct(id)).not.toBeNull()

  // 移除发布记录 → 可彻底删；链接回到未归并；规格/媒体行级联消失
  db.prepare(`DELETE FROM product_publish_jobs WHERE id = 'job_1'`).run()
  // 软删进回收站后也能彻底删（回收站行的操作）
  repo.softDeleteProduct(id)
  const result = service.purge({ productId: id })
  expect(result.media).toBeGreaterThan(0)
  expect(repo.getProduct(id)).toBeNull()
  const raw = db.prepare('SELECT COUNT(*) AS c FROM products WHERE id = ?').get(id) as { c: number }
  expect(Number(raw.c)).toBe(0)
  const variants = db.prepare('SELECT COUNT(*) AS c FROM product_variants WHERE product_id = ?').get(id) as { c: number }
  expect(Number(variants.c)).toBe(0)
  const media = db.prepare('SELECT COUNT(*) AS c FROM product_media WHERE product_id = ?').get(id) as { c: number }
  expect(Number(media.c)).toBe(0)
  const link = db.prepare('SELECT product_id FROM product_platform_links WHERE id = ?').get('link_1') as { product_id: string | null }
  expect(link.product_id).toBeNull() // 回到「未归并」
})
