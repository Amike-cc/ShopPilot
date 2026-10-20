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
import type { ProductDetailResult } from './product-detail-service'
import type { PlatformAdapter } from '../platform-adapters/platform-adapter'
import { platformAdapterRegistry } from '../platform-adapters/platform-adapter-registry'
import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import * as StoreManager from '../stores/store-manager'
import { borrowCollectionPage } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { isAppLocked } from '../services/security-manager'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'
import { productDetailService } from './product-detail-service'
import { emitToRenderer } from '../browser/window-browser-core'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'

/** 全量同步详情阶段的实时进度（事件 payload，只含计数与店铺 id，不含商品正文）。 */
export interface ProductFullSyncProgress {
  storeId: string
  total: number
  done: number
  succeeded: number
  failed: number
  skipped: number
  incomplete: number
  /** 最后一帧为真：本轮详情循环被用户取消，剩余商品未采集 */
  canceled?: boolean
}

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
  /** 详情采集可注入，便于全量编排单测；省略时使用默认详情服务。 */
  collectDetail?: (input: { storeId: string; platformProductId: string }) => Promise<ProductDetailResult>
}

function createDefaultRuntime(): ProductSyncRuntime {
  const database = getDatabase()
  return {
    getStore: StoreManager.getStore,
    borrowCollectionPage,
    getAdapter: platform => platformAdapterRegistry.resolveAdapter(platform),
    detectLoginStatus: detectStoreLoginStatus,
    isLocked: isAppLocked,
    repository: new ProductRepository(database),
    collectDetail: input => productDetailService.collect(input)
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

export interface ProductFullSyncResult extends ProductSyncResult {
  detailTotal: number
  detailSucceeded: number
  detailFailed: number
  detailSkipped: number
  /** 详情页有返回但缺少核心字段；快照已保留，不能算完整完成。 */
  detailIncomplete: number
  /** 列表未截断且每一条详情都成功才为 true。 */
  complete: boolean
  detailFailures: Array<{ platformProductId: string; status: string; reasonCode: string; safeMessage: string; missingFields?: string[] }>
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
  /** 进行中的全量同步（storeId）；取消请求置位后由详情循环在下一条前消费。 */
  private readonly fullSyncRunning = new Set<string>()
  private readonly fullSyncCancelFlags = new Set<string>()

  constructor(runtime?: ProductSyncRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  /** 该店是否正在进行全量同步（详情阶段）。 */
  isFullSyncRunning(storeId: string): boolean {
    return this.fullSyncRunning.has(assertStoreId(storeId))
  }

  /**
   * 请求中断进行中的全量详情采集。返回 false = 当前没有在跑的全量同步（如实告知，
   * 不假装"已请求取消"）。标志在下一条开始前被消费并清掉，不影响下一轮同步。
   */
  requestFullSyncCancel(storeId: string): boolean {
    const key = assertStoreId(storeId)
    if (!this.fullSyncRunning.has(key)) return false
    this.fullSyncCancelFlags.add(key)
    logMain('info', `[product-sync] 已收到全量同步取消请求 store=${key}（下一条详情前生效）`)
    return true
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

  /**
   * 全量商品资料：先完成列表同步，再按平台商品 ID 逐条进入详情页。
   *
   * 任何详情失败都会保留已成功的快照并返回 PARTIAL；不会用列表字段冒充详情，
   * 也不会因为一条坏详情回滚整个店铺已经确认的商品列表。
   */
  async syncStoreFull(input: ProductSyncInput): Promise<ProductFullSyncResult> {
    const list = await this.syncStore({
      ...input,
      maxPages: input.maxPages ?? 200,
      maxProducts: input.maxProducts ?? 5000,
      timeoutMs: input.timeoutMs ?? 600_000
    })
    const empty = (overrides: Partial<ProductFullSyncResult> = {}): ProductFullSyncResult => ({
      ...list,
      detailTotal: 0,
      detailSucceeded: 0,
      detailFailed: 0,
      detailSkipped: 0,
      detailIncomplete: 0,
      complete: false,
      detailFailures: [],
      ...overrides
    })
    if (list.status !== 'SUCCEEDED' && list.status !== 'PARTIAL') {
      return empty({ safeMessage: `${list.safeMessage}；未进入详情采集` })
    }

    const runtime = this.runtimeFactory()
    const links = runtime.repository.listLinkIdsForStore(list.storeId, input.maxProducts ?? 5000)
    const collectDetail = runtime.collectDetail
    if (!collectDetail) {
      return empty({ safeMessage: `${list.safeMessage}；当前构建没有可用的详情采集器`, detailSkipped: links.length })
    }

    let detailSucceeded = 0
    let detailFailed = 0
    let detailSkipped = 0
    let detailIncomplete = 0
    let canceled = false
    const detailFailures: ProductFullSyncResult['detailFailures'] = []
    // 取消标志 + 运行登记：循环内每条让出事件循环后再检查（2026-10-21 审查 P2-5：
    // 此前 5000 条串行既无法取消、还会长时间阻塞主进程事件循环，其它 IPC 全部饿死）。
    const storeKey = list.storeId
    this.fullSyncRunning.add(storeKey)
    this.fullSyncCancelFlags.delete(storeKey)
    const emitProgress = (): void => {
      const payload: ProductFullSyncProgress = {
        storeId: storeKey, total: links.length, done: detailSucceeded + detailFailed + detailSkipped + detailIncomplete,
        succeeded: detailSucceeded, failed: detailFailed, skipped: detailSkipped, incomplete: detailIncomplete, canceled: canceled || undefined
      }
      try { emitToRenderer(EVENT_CHANNELS.PRODUCT_SYNC_FULL_PROGRESS, payload) } catch { /* 进度事件是尽力而为 */ }
    }
    try {
      for (const link of links) {
        // 让出事件循环：详情单条最长可达几十秒，不让出的话期间所有 IPC/定时器都被挂起
        await new Promise<void>(resolve => setImmediate(resolve))
        if (this.fullSyncCancelFlags.has(storeKey)) {
          this.fullSyncCancelFlags.delete(storeKey)
          canceled = true
          logMain('info', `[product-sync] 全量同步被用户中断 store=${storeKey} done=${detailSucceeded + detailFailed + detailSkipped + detailIncomplete}/${links.length}`)
          break
        }
        try {
          const result = await collectDetail({ storeId: list.storeId, platformProductId: link.platformProductId })
          if (result.status === 'SUCCEEDED') {
            detailSucceeded += 1
            // 快照可以保存“已读到的部分”，但只要核心字段仍缺失，
            // 就不能把整轮宣称为完整资料。保留缺失字段，供界面逐条重试/补录。
            if (result.missingFields.length) {
              detailIncomplete += 1
              detailFailures.push({
                platformProductId: link.platformProductId,
                status: 'INCOMPLETE',
                reasonCode: 'DETAIL_FIELDS_MISSING',
                safeMessage: `详情已保存，但仍缺少：${result.missingFields.join('、')}`,
                missingFields: result.missingFields
              })
            }
          }
          else if (result.status === 'NOT_VERIFIED' || result.status === 'LINK_NOT_FOUND') {
            detailSkipped += 1
            detailFailures.push({ platformProductId: link.platformProductId, status: result.status, reasonCode: result.reasonCode, safeMessage: result.safeMessage })
          } else {
            detailFailed += 1
            detailFailures.push({ platformProductId: link.platformProductId, status: result.status, reasonCode: result.reasonCode, safeMessage: result.safeMessage })
          }
        } catch (error) {
          detailFailed += 1
          detailFailures.push({
            platformProductId: link.platformProductId,
            status: 'FAILED',
            reasonCode: 'DETAIL_SERVICE_ERROR',
            safeMessage: '详情采集服务异常，本条未写入详情快照'
          })
          logMain('warn', `[product-sync] 全量详情失败 store=${list.storeId} product=${link.platformProductId} error=${String((error as Error)?.message || error).slice(0, 160)}`)
        }
        emitProgress()
      }
      emitProgress()
    } finally {
      this.fullSyncRunning.delete(storeKey)
      this.fullSyncCancelFlags.delete(storeKey)
    }

    // fetchedCount 包含“没有平台 ID 而被跳过”的行；这类行无法进入详情阶段，
    // 因此不能把“详情循环跑完”误报成全量完成。只有列表未截断、没有跳过行，
    // 且每一条可追踪商品都成功读取详情，才允许 complete=true。
    const expectedDetailTotal = Math.max(0, list.fetchedCount - list.skippedCount)
    const complete = list.status === 'SUCCEEDED'
      && !list.hasMore
      && list.skippedCount === 0
      && links.length === expectedDetailTotal
      && detailSucceeded === links.length
      && detailIncomplete === 0
      && detailFailed === 0
      && detailSkipped === 0
    const status: ProductFullSyncResult['status'] = complete ? 'SUCCEEDED' : 'PARTIAL'
    const canceledNote = canceled
      ? `；已按用户要求中断，剩余 ${links.length - detailSucceeded - detailFailed - detailSkipped - detailIncomplete} 条未采集`
      : ''
    const safeMessage = complete
      ? `已完成全量商品资料：列表 ${links.length} 件，详情全部采集成功`
      : `商品列表 ${list.fetchedCount} 件；详情成功 ${detailSucceeded}、字段不完整 ${detailIncomplete}、失败 ${detailFailed}、未验证 ${detailSkipped}${list.hasMore ? '；列表本轮被截断，还有更多商品' : ''}${canceledNote}`
    return {
      ...list,
      status,
      safeMessage,
      detailTotal: links.length,
      detailSucceeded,
      detailFailed,
      detailSkipped,
      detailIncomplete,
      complete,
      detailFailures
    }
  }

  /** 界面用：某店最近一次同步（失败信息只挂最近一次，不用"早就被后续成功覆盖的旧失败"吓人）。 */
  latestRun(storeId: string) {
    return this.runtimeFactory().repository.latestSyncRun(assertStoreId(storeId))
  }
}

export const productSyncService = new ProductSyncService()
