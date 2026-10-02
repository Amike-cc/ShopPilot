import { describe, expect, it, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import type { WebContents } from 'electron'
import { migrate, migrations } from '../../apps/desktop/src/main/db/migrations'
import { ProductRepository } from '../../apps/desktop/src/main/products/product-repository'
import { ProductSyncService, type ProductSyncRuntime } from '../../apps/desktop/src/main/products/product-sync-service'
import type { PlatformProduct, PlatformProductCollectionResult } from '../../packages/shared/src/contracts/platform-product'

// 与 migrations.test.ts 同一套办法：用 node:sqlite 在真实 SQLite 上跑，避免 better-sqlite3 的 Electron ABI 问题。
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

const STORE_ID = 'store_wechat_test'
const PLATFORM = '微信小店'

/** 造一个"商品能力已实测"的假适配器：能力位为真 + 真的实现了 collectProducts。 */
function fakeAdapter(result: PlatformProductCollectionResult | (() => Promise<PlatformProductCollectionResult>), capable = true) {
  return {
    adapterName: '微信小店SalesMetricsAdapter',
    adapterVersion: 'test-v1',
    platform: PLATFORM,
    supports: (p: string) => p === PLATFORM,
    getCapabilities: () => ({
      loginDetection: true, orders: false, salesMetrics: true, productSalesMetrics: false,
      products: capable, inventory: false, refunds: false, salesData: false
    }),
    detectLoginStatus: async () => ({ platform: PLATFORM, storeId: STORE_ID, status: 'LOGGED_IN' as const, checkedAt: 0, reasonCode: 'OK', safeMessage: 'ok', evidenceType: 'DOM' as const }),
    collectProducts: async () => (typeof result === 'function' ? await result() : result)
  }
}

function okResult(products: PlatformProduct[], overrides: Partial<PlatformProductCollectionResult> = {}): PlatformProductCollectionResult {
  return {
    status: 'SUCCEEDED', products, fetchedCount: products.length, skippedCount: 0, pageCount: 1,
    hasMore: false, reasonCode: 'OK', safeMessage: `已同步 ${products.length} 件`, ...overrides
  }
}

/** 实测形态的商品（标题+ID 同格、￥ 前缀价格）—— 用真实文本，不用编造的数字。 */
function product(id: string, title: string, price = 2990): PlatformProduct {
  return {
    platformProductId: id, title, subtitle: null, status: 'on_sale', priceMinor: price, stock: 100,
    categoryPath: null, imageUrls: [], skus: [], platformUpdatedAt: null, rawRow: [title, `￥${price / 100}`]
  }
}

function setupRuntime(overrides: Partial<ProductSyncRuntime> = {}): { runtime: ProductSyncRuntime; db: SqliteDb; repo: ProductRepository } {
  const db = new DatabaseSyncCtor!(':memory:')
  // 全量迁移：拿到与生产一致的完整表结构（含 stores 与商品域）
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
  // stores 的 admin_url / status / avatar_color 都是 NOT NULL（v1 的表结构），插入时必须带上
  db.prepare(`
    INSERT INTO stores (id, name, platform, admin_url, status, avatar_color, created_at, updated_at)
    VALUES (?, '微信小店测试', ?, 'https://store.weixin.qq.com/shop/home', 'online', '#000', 0, 0)
  `).run(STORE_ID, PLATFORM)

  const repo = new ProductRepository(shim as never)
  const fakeWc = { isDestroyed: () => false, getURL: () => 'https://store.weixin.qq.com/shop/goods/list' } as unknown as WebContents
  /** 归还专用页的调用记录：采集结束必须归还（不留常驻渲染进程） */
  const released: string[] = []
  const runtime: ProductSyncRuntime = {
    getStore: () => ({ id: STORE_ID, name: '微信小店测试', platform: PLATFORM } as never),
    // 采集借的是**专用页**（独立标签页，不碰用户正在用的标签页，见 window-manager.borrowCollectionPage）
    borrowCollectionPage: () => ({
      waitForWebContents: async () => fakeWc,
      release: () => { released.push(STORE_ID) }
    }),
    getAdapter: () => fakeAdapter(okResult([])) as never,
    detectLoginStatus: async () => ({ platform: PLATFORM, storeId: STORE_ID, status: 'LOGGED_IN', checkedAt: 0, reasonCode: 'OK', safeMessage: 'ok', evidenceType: 'DOM' }),
    isLocked: () => false,
    repository: repo,
    ...overrides
  }
  return { runtime, db, repo, released }
}

function countLinks(db: SqliteDb): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM product_platform_links').get() as { c: number }).c)
}
function statusOf(db: SqliteDb, id: string): string | null {
  const row = db.prepare('SELECT platform_status FROM product_platform_links WHERE platform_product_id = ?').get(id) as { platform_status: string } | undefined
  return row?.platform_status ?? null
}
function runCount(db: SqliteDb): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM product_sync_runs').get() as { c: number }).c)
}

const realIt = DatabaseSyncCtor ? it : it.skip

describe('商品同步服务：编排的每一步都要"要么写对、要么明说为什么没写"', () => {
  beforeEach(() => { /* 每个用例各自建库，互不影响 */ })

  realIt('未登录（明确否定证据）：一行商品都不写，但台账必须留下这一笔', async () => {
    const { runtime, db } = setupRuntime({
      detectLoginStatus: async () => ({ platform: PLATFORM, storeId: STORE_ID, status: 'LOGIN_REQUIRED', checkedAt: 0, reasonCode: 'LOGIN_REQUIRED', safeMessage: '需要登录', evidenceType: 'URL' })
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('LOGIN_REQUIRED')
    expect(countLinks(db)).toBe(0)          // 关键：没有写任何商品
    expect(runCount(db)).toBe(1)            // 但台账有记录
    expect(runtime.repository.latestSyncRun(STORE_ID)?.status).toBe('LOGIN_REQUIRED')
    db.close()
  })

  realIt('登录态**判不出来**（UNKNOWN）时必须继续采集，不能当成"未登录"', async () => {
    // 真机验收实测到的坑（2026-09-30）：微信小店的登录正向锚点是"经营数据"，只在后台首页有；
    // 店铺标签页停在商品列表页时登录检测只能给 UNKNOWN —— 若把 UNKNOWN 当未登录，
    // 页面上明明摆着 4 个商品却报"该店铺未登录"。
    const products = [product('10001', '儿童加厚款暖暖套装')]
    const { runtime, db } = setupRuntime({
      detectLoginStatus: async () => ({ platform: PLATFORM, storeId: STORE_ID, status: 'UNKNOWN', checkedAt: 0, reasonCode: 'DETECTION_EVIDENCE_INSUFFICIENT', safeMessage: '无法确认', evidenceType: 'NONE' }),
      getAdapter: () => fakeAdapter(okResult(products)) as never
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('SUCCEEDED')   // 继续采集，并且成功了
    expect(result.insertedCount).toBe(1)
    expect(countLinks(db)).toBe(1)
    db.close()
  })

  realIt('登录态判不出来**且**采集失败：失败原因里必须带上"也可能是会话过期"这条线索', async () => {
    const { runtime } = setupRuntime({
      detectLoginStatus: async () => ({ platform: PLATFORM, storeId: STORE_ID, status: 'UNKNOWN', checkedAt: 0, reasonCode: 'DETECTION_EVIDENCE_INSUFFICIENT', safeMessage: '无法确认', evidenceType: 'NONE' }),
      getAdapter: () => fakeAdapter({ status: 'PAGE_CHANGED', products: [], fetchedCount: 0, skippedCount: 0, pageCount: 0, hasMore: false, reasonCode: 'PAGE_NOT_READY', safeMessage: '页面没就绪' }) as never
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('PAGE_CHANGED')
    // 不能只丢一句"平台改版"给用户 —— 两种可能都要说清
    expect(result.safeMessage).toContain('会话已过期')
    expect(result.safeMessage).toContain('页面没就绪')
  })

  realIt('平台改版（PAGE_CHANGED）：不写脏数据，也不标 missing', async () => {
    const { runtime, db } = setupRuntime({
      getAdapter: () => fakeAdapter({ status: 'PAGE_CHANGED', products: [], fetchedCount: 0, skippedCount: 0, pageCount: 0, hasMore: false, reasonCode: 'HEADERS_CHANGED', safeMessage: '表头与登记的不一致' }) as never
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('PAGE_CHANGED')
    expect(countLinks(db)).toBe(0)
    db.close()
  })

  realIt('正常同步 → 首次全部 inserted；重复同步 → inserted=0 且 skipped=条数（幂等）', async () => {
    const products = [product('10001', '儿童加厚款暖暖套装'), product('10002', '半自动打蛋器搅拌棒')]
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(okResult(products)) as never })
    const service = new ProductSyncService(runtime)

    const first = await service.syncStore({ storeId: STORE_ID })
    expect(first.status).toBe('SUCCEEDED')
    expect(first.insertedCount).toBe(2)
    expect(countLinks(db)).toBe(2)

    const second = await service.syncStore({ storeId: STORE_ID })
    expect(second.insertedCount).toBe(0)
    expect(second.skippedCount).toBe(2)     // 内容没变 → 不写库
    expect(countLinks(db)).toBe(2)
    expect(runCount(db)).toBe(2)
    db.close()
  })

  realIt('商品变了 → 走 updated 而不是再插一行（价格 29.90 → 39.90）', async () => {
    let price = 2990
    const { runtime, db } = setupRuntime({
      getAdapter: () => fakeAdapter(() => okResult([product('10001', '儿童加厚款暖暖套装', price)])) as never
    })
    const service = new ProductSyncService(runtime)
    await service.syncStore({ storeId: STORE_ID })
    price = 3990
    const second = await service.syncStore({ storeId: STORE_ID })

    expect(second.updatedCount).toBe(1)
    expect(second.insertedCount).toBe(0)
    expect(countLinks(db)).toBe(1)
    const row = db.prepare('SELECT platform_price_minor FROM product_platform_links WHERE platform_product_id = ?').get('10001') as { platform_price_minor: number }
    expect(row.platform_price_minor).toBe(3990)
    db.close()
  })

  realIt('**截断轮次绝不标 missing**：被截断的一轮里"没拉到"不等于"平台上没了"', async () => {
    let result = okResult([product('10001', 'A'), product('10002', 'B')])
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(() => result) as never })
    const service = new ProductSyncService(runtime)

    await service.syncStore({ storeId: STORE_ID })
    expect(statusOf(db, '10001')).toBe('on_sale')

    // 第二轮被截断（只拉到 1 件、hasMore=true）→ 10002 不许被标 missing
    result = okResult([product('10001', 'A')], { hasMore: true, reasonCode: 'TRUNCATED' })
    const second = await service.syncStore({ storeId: STORE_ID })

    expect(second.hasMore).toBe(true)
    expect(second.missingCount).toBe(0)
    expect(statusOf(db, '10002')).toBe('on_sale')
    db.close()
  })

  realIt('**读到 0 行（EMPTY_TABLE）绝不把已有商品标成 missing** —— 页面渲染中间态不是"商品都没了"', async () => {
    // 2026-09-30 四平台验收抓到的**数据破坏性**缺陷：页面刚打开时表格可能"已渲染但没填数据"，
    // 同一秒读到的「共0条」几秒后会变成「共4条」。若把它当完整轮次，markMissing 会把该店
    // 已有商品全部标成 missing —— 数据被自己的同步破坏。
    let result = okResult([product('10001', 'A'), product('10002', 'B')])
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(() => result) as never })
    const service = new ProductSyncService(runtime)

    await service.syncStore({ storeId: STORE_ID })
    expect(statusOf(db, '10001')).toBe('on_sale')

    result = okResult([], { hasMore: true, reasonCode: 'EMPTY_TABLE', safeMessage: '这次没有读到商品行（可能是这家店确实 0 个商品，也可能是页面还没渲染完）' })
    const second = await service.syncStore({ storeId: STORE_ID })

    expect(second.missingCount).toBe(0)                 // 关键：一条都没被标 missing
    expect(statusOf(db, '10001')).toBe('on_sale')
    expect(statusOf(db, '10002')).toBe('on_sale')
    expect(second.safeMessage).toContain('没有读到商品行')  // 如实说清，而不是假装同步成功
    db.close()
  })

  realIt('平台上消失又回来的商品必须**复活**（内容没变也要把 missing 改回在售）', async () => {
    // 2026-09-30 四平台验收实测到：标 missing 时只改了 platform_status、没改指纹，
    // 于是下一轮"指纹相同 → 跳过"，状态永远卡在 missing。
    let products = [product('10001', 'A'), product('10002', 'B')]
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(() => okResult(products)) as never })
    const service = new ProductSyncService(runtime)

    await service.syncStore({ storeId: STORE_ID })
    products = [product('10001', 'A')]                       // 10002 消失
    await service.syncStore({ storeId: STORE_ID })
    expect(statusOf(db, '10002')).toBe('missing')

    products = [product('10001', 'A'), product('10002', 'B')] // 10002 回来了（内容与消失前完全一样）
    const third = await service.syncStore({ storeId: STORE_ID })

    expect(third.missingCount).toBe(0)
    expect(third.updatedCount).toBe(1)                        // 因为状态变了，必须真的写一次
    expect(statusOf(db, '10002')).toBe('on_sale')             // 复活成功
    db.close()
  })

  realIt('条数对不上（INCOMPLETE_RENDER）也按不完整轮次处理：页面还没渲染完不算"商品都没了"', async () => {
    // 快手实测形态：冷启动时列表短暂处于「只有 1 行骨架 + 自报共0条」，
    // 只判"0 行"挡不住它（1 行假数据绕过去了），于是那一轮把已有 4 个商品标成了 missing。
    // 适配器现在会用"页面自报条数 vs 读到行数"对账，不一致就 hasMore=true。
    let result = okResult([product('10001', 'A'), product('10002', 'B')])
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(() => result) as never })
    const service = new ProductSyncService(runtime)
    await service.syncStore({ storeId: STORE_ID })

    result = okResult([product('10001', 'A')], {
      hasMore: true,
      reasonCode: 'INCOMPLETE_RENDER',
      safeMessage: '页面显示共 2 条，但只读到 1 行 —— 页面可能还没渲染完，本次不改动已有数据，请再同步一次'
    })
    const second = await service.syncStore({ storeId: STORE_ID })

    expect(second.missingCount).toBe(0)
    expect(statusOf(db, '10002')).toBe('on_sale')
    expect(second.safeMessage).toContain('还没渲染完')
    db.close()
  })

  realIt('完整轮次才标 missing：本轮没出现的商品标 missing，**但不删行**', async () => {
    let products = [product('10001', 'A'), product('10002', 'B')]
    const { runtime, db } = setupRuntime({
      getAdapter: () => fakeAdapter(() => okResult(products)) as never
    })
    const service = new ProductSyncService(runtime)
    await service.syncStore({ storeId: STORE_ID })

    products = [product('10001', 'A')]                     // 10002 在平台上消失了
    const second = await service.syncStore({ storeId: STORE_ID })

    expect(second.missingCount).toBe(1)
    expect(countLinks(db)).toBe(2)                          // 行还在（不删，本地编辑不该被连带删掉）
    expect(statusOf(db, '10002')).toBe('missing')
    db.close()
  })

  realIt('能力位没开（products=false）：明确说"该平台尚未实测"，且**不建台账、不借页面**', async () => {
    let opened = false
    const { runtime, db } = setupRuntime({
      getAdapter: () => fakeAdapter(okResult([]), false) as never,
      borrowCollectionPage: () => {
        opened = true
        return { waitForWebContents: async () => null, release: () => { /* 没借到就不用还 */ } }
      }
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('DATA_SOURCE_NOT_VERIFIED')
    expect(result.safeMessage).toContain('尚未实测')
    expect(opened).toBe(false)
    expect(runCount(db)).toBe(0)
    db.close()
  })

  realIt('适配器抛错：报 FAILED 且不留半条数据', async () => {
    const { runtime, db, released } = setupRuntime({
      getAdapter: () => fakeAdapter(async () => { throw new Error('boom') }) as never
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('FAILED')
    expect(result.reasonCode).toBe('ADAPTER_ERROR')
    expect(countLinks(db)).toBe(0)
    // 抛错路径也必须归还专用页，否则每失败一次就留一个常驻渲染进程
    expect(released.length).toBe(1)
    db.close()
  })

  // ---------- 采集不碰用户的标签页 / 采完归还（2026-10-02）----------
  realIt('同步成功 → 采集在专用页里跑，结束后归还（用户标签页全程没被使用）', async () => {
    const { runtime, db, released } = setupRuntime()
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('SUCCEEDED')
    expect(released.length).toBe(1)
    db.close()
  })

  realIt('借不到专用页 → 如实报 PAGE_NOT_READY，并归还（不偷偷改用用户的标签页）', async () => {
    const released: string[] = []
    const { runtime, db } = setupRuntime({
      borrowCollectionPage: () => ({
        waitForWebContents: async () => null,
        release: () => { released.push(STORE_ID) }
      })
    })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.status).toBe('PAGE_NOT_READY')
    expect(released.length).toBe(1)
    expect(runCount(db)).toBe(0)
    db.close()
  })

  realIt('应用锁定 / 店铺不存在：直接返回，不碰数据库', async () => {
    const locked = setupRuntime({ isLocked: () => true })
    expect((await new ProductSyncService(locked.runtime).syncStore({ storeId: STORE_ID })).status).toBe('LOCKED')
    expect(countLinks(locked.db)).toBe(0)

    const missing = setupRuntime({ getStore: () => null })
    expect((await new ProductSyncService(missing.runtime).syncStore({ storeId: STORE_ID })).status).toBe('STORE_NOT_FOUND')
    expect(runCount(missing.db)).toBe(0)
    locked.db.close(); missing.db.close()
  })

  realIt('图片地址变化也要算"变了"（本地化要靠它，不能因为张数没变就跳过）', async () => {
    // 2026-09-30 M2 验收踩到：一行"只差图片地址"（张数一样）时指纹说没变 → 跳过 →
    // platform_image_urls_json 永远是空的，图片本地化整条链路没有输入。
    let urls = ['https://mmec.wxqcloud.qq.com.cn/a.jpg']
    const { runtime, db } = setupRuntime({
      getAdapter: () => fakeAdapter(() => okResult([{ ...product('10001', 'A'), imageUrls: urls }])) as never
    })
    const service = new ProductSyncService(runtime)
    await service.syncStore({ storeId: STORE_ID })
    const first = db.prepare('SELECT platform_image_urls_json FROM product_platform_links WHERE platform_product_id = ?').get('10001') as { platform_image_urls_json: string }
    expect(JSON.parse(first.platform_image_urls_json)).toEqual(urls)

    urls = ['https://mmec.wxqcloud.qq.com.cn/b.jpg']          // 换图（张数不变）
    const second = await service.syncStore({ storeId: STORE_ID })
    expect(second.updatedCount).toBe(1)
    const after = db.prepare('SELECT platform_image_urls_json FROM product_platform_links WHERE platform_product_id = ?').get('10001') as { platform_image_urls_json: string }
    expect(JSON.parse(after.platform_image_urls_json)).toEqual(urls)
    db.close()
  })

  realIt('没有平台商品 ID 的行被跳过并计数（没有幂等键就不落库，但要如实计数）', async () => {
    const noId = { ...product('', '没有编号的标题') }
    const { runtime, db } = setupRuntime({ getAdapter: () => fakeAdapter(okResult([noId, product('10009', '有编号')])) as never })
    const result = await new ProductSyncService(runtime).syncStore({ storeId: STORE_ID })

    expect(result.fetchedCount).toBe(2)
    expect(countLinks(db)).toBe(1)
    db.close()
  })
})
