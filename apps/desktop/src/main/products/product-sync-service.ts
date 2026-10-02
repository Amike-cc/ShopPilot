/**
 * 商品同步服务（商品管理方案 §5.3 的九步管线）
 *
 * 一条纪律贯穿全文：**读不到、判不出、平台改版 —— 一律如实报，绝不写脏数据**。
 * 具体落到三处：
 *   1) 登录门禁在采集之前：非 LOGGED_IN 直接返回，**一行商品都不写**（只写台账，让用户看得见为什么没同步）；
 *   2) 采集不是 SUCCEEDED/PARTIAL 时同样不写商品（表头失配 = 平台改版，列错位会把库存写成价格）；
 *   3) **只有完整轮次才允许标记 missing** —— 被截断的一轮里，"没拉到"的商品不代表平台上没了（方案 §5.7）。
 *
 * 与经营采集服务同构：运行时依赖可注入，所以核心编排能在单测里用假数据跑完整条路径。
 */

import type { WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import type { PlatformLoginResult } from '@shared/contracts/platform-adapter'
import type {
  PlatformProductCollectionOptions,
  PlatformProductCollectionResult
} from '@shared/contracts/platform-product'
import type { PlatformAdapter } from '../platform-adapters/platform-adapter'
import { platformAdapterRegistry } from '../platform-adapters/platform-adapter-registry'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import * as StoreManager from '../stores/store-manager'
import { borrowCollectionPage } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { isAppLocked } from '../services/security-manager'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'

/** 商品采集能力：能力位为真、且真的有 collectProducts 实现（两者缺一不可）。 */
export interface ProductCapableAdapter extends PlatformAdapter {
  collectProducts(
    context: Parameters<PlatformAdapter['detectLoginStatus']>[0],
    options: PlatformProductCollectionOptions
  ): Promise<PlatformProductCollectionResult>
}

export function isProductCapable(adapter: PlatformAdapter | null): adapter is ProductCapableAdapter {
  return !!adapter
    && adapter.getCapabilities().products === true
    && typeof (adapter as Partial<ProductCapableAdapter>).collectProducts === 'function'
}

export interface ProductSyncRuntime {
  getStore: (storeId: string) => Store | null
  /**
   * 借一个**采集专用页面**（独立标签页，不激活、不进标签栏，不碰用户正在用的标签页）。
   * 采集的导航/读值全落在它上面；`release()` 归还时关掉它（见 window-manager.borrowCollectionPage）。
   */
  borrowCollectionPage: (storeId: string) => {
    waitForWebContents: (timeoutMs?: number) => Promise<WebContents | null>
    release: () => void
  }
  getAdapter: (platform: string) => PlatformAdapter | null
  detectLoginStatus: (storeId: string) => Promise<PlatformLoginResult>
  isLocked: () => boolean
  repository: ProductRepository
}

function createDefaultRuntime(): ProductSyncRuntime {
  const database = getDatabase()
  return {
    getStore: StoreManager.getStore,
    borrowCollectionPage,
    getAdapter: platform => platformAdapterRegistry.resolveAdapter(platform),
    detectLoginStatus: detectStoreLoginStatus,
    isLocked: isAppLocked,
    repository: new ProductRepository(database)
  }
}

export interface ProductSyncInput {
  storeId: string
  trigger?: 'manual' | 'schedule'
  maxPages?: number
  maxProducts?: number
  timeoutMs?: number
  /**
   * 是否允许在"完整轮次"里把本轮没出现的商品标成 missing。
   * 默认 true；但**只有完整轮次才会真正生效**（截断轮次永不标记）。
   */
  markMissing?: boolean
}

export interface ProductSyncResult {
  storeId: string
  platform: string
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'LOGIN_REQUIRED' | 'VERIFY_REQUIRED' | 'PAGE_CHANGED' | 'DATA_SOURCE_NOT_VERIFIED' | 'LOCKED' | 'STORE_NOT_FOUND' | 'PAGE_NOT_READY'
  reasonCode: string
  safeMessage: string
  runId: string | null
  fetchedCount: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  missingCount: number
  pageCount: number
  hasMore: boolean
  startedAt: number
  finishedAt: number
}

const DEFAULT_OPTIONS: Required<Pick<ProductSyncInput, 'maxPages' | 'maxProducts' | 'timeoutMs'>> = {
  maxPages: 20,
  maxProducts: 500,
  timeoutMs: 120_000
}

function assertStoreId(storeId: string): string {
  if (typeof storeId !== 'string' || !storeId.trim() || storeId.length > 128) throw new Error('INVALID_ARGUMENT')
  return storeId.trim()
}

export class ProductSyncService {
  private readonly runtimeFactory: () => ProductSyncRuntime

  constructor(runtime?: ProductSyncRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  /**
   * 同步一家店的商品。
   *
   * 顺序（每一步失败都能单独收尾并留下台账）：
   *   锁 → 店铺 → 适配器能力位 → 打开页面 → **登录门禁** → 建轮次 → 采集 → 事务落库 → 收尾台账
   */
  async syncStore(input: ProductSyncInput): Promise<ProductSyncResult> {
    const storeId = assertStoreId(input.storeId)
    const trigger = input.trigger === 'schedule' ? 'schedule' : 'manual'
    const startedAt = Date.now()

    const base = (status: ProductSyncResult['status'], reasonCode: string, safeMessage: string, platform = '', runId: string | null = null): ProductSyncResult => ({
      storeId, platform, status, reasonCode, safeMessage, runId,
      fetchedCount: 0, insertedCount: 0, updatedCount: 0, skippedCount: 0, missingCount: 0,
      pageCount: 0, hasMore: false, startedAt, finishedAt: Date.now()
    })

    const runtime = this.runtimeFactory()
    if (runtime.isLocked()) return base('LOCKED', 'APP_LOCKED', '应用已锁定，解锁后再同步')

    const store = runtime.getStore(storeId)
    if (!store) return base('STORE_NOT_FOUND', 'STORE_NOT_FOUND', '店铺不存在或已删除')

    const adapter = runtime.getAdapter(store.platform)
    if (!isProductCapable(adapter)) {
      return base('DATA_SOURCE_NOT_VERIFIED', 'PLATFORM_NOT_VERIFIED',
        `${store.platform}尚未实测到商品列表，暂不能同步`, store.platform)
    }

    // 页面：借一个**采集专用页**（独立标签页，不激活、不进标签栏）。
    // 用户的标签页与当前视图自始至终没动 —— 这是 2026-10-02「采集任务时不要影响浏览器使用」的要求。
    // 它同时满足"必须从新标签页进"这条实测结论（见下面 collectProducts 前的说明）：
    // 专用页天生没有商品编辑页的状态，导航不会被平台拦下。
    const page = runtime.borrowCollectionPage(storeId)
    // 归还函数是幂等的：每条退出路径都调一次，绝不留常驻渲染进程
    const releasePage = (): void => { try { page.release() } catch { /* 关不掉不影响采集结果 */ } }

    let wc: WebContents | null = null
    try {
      wc = await page.waitForWebContents(30_000)
    } catch (error) {
      logMain('warn', `[product-sync] 采集专用页准备失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 120)}`)
    }
    if (!wc || wc.isDestroyed()) {
      releasePage()
      return base('PAGE_NOT_READY', 'PAGE_NOT_READY', '店铺页面不可用，请先打开该店铺', store.platform)
    }

    const login = await runtime.detectLoginStatus(storeId)

    // 登录门禁：**在采集之前**。会话过期时去抓页面拿到的是登录页，抓回来就是脏数据。
    //
    // 但只拦**明确的否定证据**（LOGIN_REQUIRED / VERIFY_REQUIRED）。
    // `UNKNOWN` 绝不当成"未登录"——判不出来不等于没登录（项目纪律：未知证据不得降级，
    // 与 STORE_STATUS 那条修复同一个道理）。真机验收实测到过这个坑（2026-09-30）：
    // 微信小店的登录正向锚点是"经营数据"（成交金额…），只存在于后台**首页**；
    // 店铺标签页停在**商品列表页**时登录检测只能给 UNKNOWN，
    // 若把 UNKNOWN 当未登录，页面上明明有 4 个商品却报"该店铺未登录"。
    // 采集侧遇到真正的登录页会命中已实测文案并如实返回 LOGIN_REQUIRED（见适配器）。
    if (login.status === 'LOGIN_REQUIRED' || login.status === 'VERIFY_REQUIRED') {
      const status = login.status === 'VERIFY_REQUIRED' ? 'VERIFY_REQUIRED' : 'LOGIN_REQUIRED'
      const safeMessage = login.status === 'VERIFY_REQUIRED'
        ? '该店铺需要在浏览器里完成安全验证'
        : '该店铺未登录（或登录已过期），请先在店铺浏览器里登录'
      // 台账要留下这一笔：否则用户只看到"没有商品"，看不出是没登录
      const runId = runtime.repository.startSyncRun({ storeId, trigger, startedAt })
      runtime.repository.finishSyncRun({
        runId, status: 'LOGIN_REQUIRED', reasonCode: login.reasonCode, fetchedCount: 0,
        insertedCount: 0, updatedCount: 0, missingCount: 0, skippedCount: 0,
        hasMore: false, pageCount: 0, durationMs: Date.now() - startedAt,
        safeMessage, finishedAt: Date.now()
      })
      releasePage()
      return { ...base(status, login.reasonCode, safeMessage, store.platform, runId) }
    }

    const options: PlatformProductCollectionOptions = {
      maxPages: Math.max(1, Number(input.maxPages ?? DEFAULT_OPTIONS.maxPages)),
      maxProducts: Math.max(1, Number(input.maxProducts ?? DEFAULT_OPTIONS.maxProducts)),
      timeoutMs: Math.max(5_000, Number(input.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs))
    }
    // 登录检测判不出来（UNKNOWN）时如实记一笔：采集成功说明确实登录着；采集失败时用户能看到
    // "登录状态没确认"这条线索，而不是只看到一句笼统的失败。
    const loginUnconfirmed = login.status !== 'LOGGED_IN'
    if (loginUnconfirmed) {
      logMain('info', `[product-sync] 登录状态未确认（${login.reasonCode}），继续采集 store=${storeId}`)
    }

    const runId = runtime.repository.startSyncRun({ storeId, trigger, startedAt })
    const fail = (status: ProductSyncResult['status'], reasonCode: string, safeMessage: string): ProductSyncResult => {
      runtime.repository.finishSyncRun({
        runId, status, reasonCode, fetchedCount: 0, insertedCount: 0, updatedCount: 0,
        missingCount: 0, skippedCount: 0, hasMore: false, pageCount: 0,
        durationMs: Date.now() - startedAt, safeMessage, finishedAt: Date.now()
      })
      return base(status, reasonCode, safeMessage, store.platform, runId)
    }

    let collected: PlatformProductCollectionResult
    try {
      // 采集页就是上面借来的**专用页**（独立标签页，天生没有商品编辑页的状态）：
      // 实测（2026-10-02）在用户停在商品编辑页的标签页里导航到 `…/shop/goods/list` 会被平台
      // 拦下（URL 没变，仍是 `/shop/goods/entry?productId=…`），于是「商品列表」永不出现，
      // 同步只报一句误导性的"平台可能已改版"。专用页没有那个状态，因此从它进。
      collected = await adapter.collectProducts(
        { storeId, platform: store.platform, session: undefined as never, webContents: wc, currentUrl: wc.getURL(), timeoutMs: options.timeoutMs },
        options
      )
    } catch (error) {
      releasePage()
      logMain('warn', `[product-sync] collectProducts 抛错 store=${storeId} platform=${store.platform} error=${String((error as Error)?.message || error)}`)
      return fail('FAILED', 'ADAPTER_ERROR', '采集商品时出错（本次未写入任何数据）')
    }
    // 采完立刻归还专用页：不留下常驻渲染进程，也不让用户的标签栏多出东西
    releasePage()

    if (collected.status !== 'SUCCEEDED' && collected.status !== 'PARTIAL') {
      const mapped: ProductSyncResult['status'] =
        collected.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED'
          : collected.status === 'PAGE_CHANGED' ? 'PAGE_CHANGED'
            : collected.status === 'DATA_SOURCE_NOT_VERIFIED' ? 'DATA_SOURCE_NOT_VERIFIED'
              : 'FAILED'
      // 登录状态本来就没确认（UNKNOWN）时，失败原因里如实带上这条线索 —— 让用户知道
      // "也可能是会话过期了"，而不是只看到一句笼统的失败。
      const hint = loginUnconfirmed && (mapped === 'PAGE_CHANGED' || mapped === 'FAILED')
        ? '（另外：本次没能确认登录状态，也可能是会话已过期——请顺手看一眼店铺是否还登录着）'
        : ''
      return fail(mapped, collected.reasonCode, collected.safeMessage + hint)
    }

    // 关键：**只有完整轮次才允许标记 missing**。截断的一轮里"没拉到"不等于"平台上没了"。
    const complete = !collected.hasMore && collected.status === 'SUCCEEDED'
    const markMissing = input.markMissing !== false && complete

    let counts = { inserted: 0, updated: 0, skipped: 0, missing: 0 }
    try {
      counts = runtime.repository.upsertCollected({
        storeId,
        platform: store.platform,
        products: collected.products,
        collectedAt: Date.now(),
        markMissing
      })
    } catch (error) {
      logMain('warn', `[product-sync] 落库失败（已回滚）store=${storeId} error=${String((error as Error)?.message || error)}`)
      return fail('FAILED', 'DB_WRITE_FAILED', '写入本地商品库失败，本次结果已回滚')
    }

    const durationMs = Date.now() - startedAt
    runtime.repository.finishSyncRun({
      runId,
      status: collected.status,
      reasonCode: collected.reasonCode,
      fetchedCount: collected.fetchedCount,
      insertedCount: counts.inserted,
      updatedCount: counts.updated,
      missingCount: counts.missing,
      skippedCount: counts.skipped,
      hasMore: collected.hasMore,
      pageCount: collected.pageCount,
      durationMs,
      safeMessage: collected.safeMessage,
      finishedAt: Date.now()
    })

    return {
      storeId,
      platform: store.platform,
      status: collected.status === 'PARTIAL' ? 'PARTIAL' : 'SUCCEEDED',
      reasonCode: collected.reasonCode,
      safeMessage: collected.safeMessage,
      runId,
      fetchedCount: collected.fetchedCount,
      insertedCount: counts.inserted,
      updatedCount: counts.updated,
      skippedCount: counts.skipped,
      missingCount: counts.missing,
      pageCount: collected.pageCount,
      hasMore: collected.hasMore,
      startedAt,
      finishedAt: Date.now()
    }
  }

  /** 界面用：某店最近一次同步（失败信息只挂最近一次，不用"早就被后续成功覆盖的旧失败"吓人）。 */
  latestRun(storeId: string) {
    return this.runtimeFactory().repository.latestSyncRun(assertStoreId(storeId))
  }
}

export const productSyncService = new ProductSyncService()
