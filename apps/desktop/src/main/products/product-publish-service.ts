/**
 * 发布服务（M3 第一段：**只到人工确认门禁为止，绝不提交**）
 *
 * 这一版只做两件事，且都不产生任何"写平台"的动作：
 *   ① `preflight`：跑发布预检（`@shared/product-publish-rules` 纯规则）→ 落台账 → 返回字段级 diff；
 *   ② `openForHuman`：把店铺页面开到发布页，进入 **L1 填充 / L2 引导 / L3 接力**，
 *      停在 `awaiting_human` —— 页面交给用户，**不点提交、不点保存**。
 *
 * 为什么先做到这里：方案的 §7.9 把"提交"定为不可配置的人工边界；
 * 在拿到"发布一个测试商品"的授权之前，把门禁、台账、核对清单、字段级 diff 全部做完并验证，
 * 才是可验证且不越界的一步。真正的字段填充（L1）与回读（§7.5）在下一段接。
 */

import type { WebContents } from 'electron'
import type { Store } from '@shared/schemas/store'
import { PRODUCT_PUBLISH_PROFILES, detailUrlFor, hasPublishProfile, publishTierFor } from '@shared/constants/product'
import { evaluateReadback, precheckPublish, type PublishPrecheckResult } from '@shared/product-publish-rules'
import { batchProgress, planBatch, type BatchPlanItem, type BatchProgress } from '@shared/product-batch-rules'
import { toBatchItemState } from '@shared/product-status'
import { compareReadbackFields, completionChecklist, type ReadbackComparison, type ReadbackSuggestion } from '@shared/product-readback-rules'
import { localProductDraftHash } from '@shared/product-draft'
import * as StoreManager from '../stores/store-manager'
import { closeTab, createTab, getTabWebContents, openStoreBrowser, setStoreLifecycleBlock, waitForStoreWebContents } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { logMain } from '../services/logger'
import { ProductRepository } from './product-repository'
import { productSyncService } from './product-sync-service'
import * as TaskStore from '../tasks/task-store'
import { confirmRun, enqueueRun } from '../tasks/task-runner'
import { WECHAT_FILL_ANCHORS, fillPublishFields, readPublishPageFieldValues, waitForPublishForm, type FillOutcome } from './product-publish-filler'

export interface PublishRuntime {
  getStore: (storeId: string) => Store | null
  waitForStoreWebContents: (storeId: string, timeoutMs?: number) => Promise<WebContents | null>
  openStorePage: (storeId: string) => void
  /** 长时间导航/回读期间阻止店铺冷休眠；注入运行时可省略。 */
  setStoreLifecycleBlock?: (storeId: string, reason: 'task' | 'confirmation' | 'upload' | 'external', active: boolean) => void
  /** 在店铺里新开一个标签页（发布页必须从新标签页进，见 openForHuman 的说明） */
  createTab: (storeId: string, url: string) => string
  /** 取指定标签页的 webContents（拿不到返回 null，调用方不许硬来） */
  getTabWebContents: (storeId: string, tabId: string) => WebContents | null
  /** 只读回读使用的临时标签页，完成后必须关闭；发布人工页不走这条路径。 */
  closeTab?: (storeId: string, tabId: string) => void
  repository: ProductRepository
}

/**
 * 一个店铺可能同时有多条发布项处于人工交接点。
 * 生命周期门禁按 item 计数，不能让确认其中一条就把另一条仍在页面上的店铺收走。
 */
const publishHumanHoldsByStore = new Map<string, Set<string>>()

function retainPublishHumanHold(runtime: PublishRuntime, storeId: string, itemId: string): void {
  const holds = publishHumanHoldsByStore.get(storeId) || new Set<string>()
  if (holds.has(itemId)) return
  const wasEmpty = holds.size === 0
  holds.add(itemId)
  publishHumanHoldsByStore.set(storeId, holds)
  if (wasEmpty) runtime.setStoreLifecycleBlock?.(storeId, 'confirmation', true)
}

function releasePublishHumanHold(runtime: PublishRuntime, storeId: string, itemId: string): void {
  const holds = publishHumanHoldsByStore.get(storeId)
  if (!holds || !holds.delete(itemId)) return
  if (holds.size > 0) return
  publishHumanHoldsByStore.delete(storeId)
  runtime.setStoreLifecycleBlock?.(storeId, 'confirmation', false)
}

/**
 * 发布项可能在人工交接期间被删除或清理；此时调用方已经拿不到 storeId，
 * 也不能把 confirmation 门禁永远留在内存里。按 itemId 扫描所有店铺只读账本，
 * 释放与该发布项对应的那一项，保留同店其它并发发布项的门禁。
 */
function releasePublishHumanHoldEverywhere(runtime: PublishRuntime, itemId: string): void {
  for (const storeId of Array.from(publishHumanHoldsByStore.keys())) {
    releasePublishHumanHold(runtime, storeId, itemId)
  }
}

function createDefaultRuntime(): PublishRuntime {
  return {
    getStore: StoreManager.getStore,
    waitForStoreWebContents,
    openStorePage: storeId => openStoreBrowser(storeId, { display: true, source: 'main' }),
    setStoreLifecycleBlock,
    createTab: (storeId, url) => createTab(storeId, url),
    getTabWebContents: (storeId, tabId) => getTabWebContents(storeId, tabId),
    closeTab: (storeId, tabId) => closeTab(storeId, tabId),
    repository: new ProductRepository(getDatabase())
  }
}

export interface PublishPreflightResult {
  ok: boolean
  jobId: string | null
  itemId: string | null
  precheck: PublishPrecheckResult | null
  reasonCode: string
  safeMessage: string
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const handle = setTimeout(resolve, ms); if (typeof handle.unref === 'function') handle.unref() })
}

export class ProductPublishService {
  private readonly runtimeFactory: () => PublishRuntime

  constructor(runtime?: PublishRuntime) {
    this.runtimeFactory = runtime ? () => runtime : createDefaultRuntime
  }

  /**
   * 发布预检：算清楚"能不能发、要让人看什么、会不会重复发"，并落一条台账。
   *
   * **不做任何平台写入**，也不打开浏览器 —— 用户在界面上看到 diff 表之后再决定下一步。
   */
  preflight(input: { productId: string; storeIds: string[] }): PublishPreflightResult {
    const runtime = this.runtimeFactory()
    const product = runtime.repository.getProduct(input.productId)
    if (!product) {
      return { ok: false, jobId: null, itemId: null, precheck: null, reasonCode: 'PRODUCT_NOT_FOUND', safeMessage: '本地商品不存在或已删除' }
    }
    if (!input.storeIds.length) {
      return { ok: false, jobId: null, itemId: null, precheck: null, reasonCode: 'NO_TARGET', safeMessage: '没有选要发布到哪些店铺' }
    }

    const jobId = runtime.repository.createPublishJob({ productId: input.productId, draftHash: product.draftHash })
    const links = runtime.repository.listLinks({ limit: 200 }).rows
      .filter(row => row.productId === input.productId)
      .map(row => ({ storeId: row.storeId, platform: row.platform, platformProductId: row.platformProductId, platformStatus: row.platformStatus ?? 'unknown' }))

    // **目标店铺排序：商品已链接的那家店排最前**（2026-10-01 实测踩到）。
    //
    // 为什么：界面「发布预检」传的是"全部在线店铺"，而服务只返回**一个** itemId/precheck（第一条）。
    // 如果第一条恰好是别的平台（实测：在线的第一家属快手小店），后面的「回读页面实际值」
    // 就会去读**快手** —— 对一个微信小店的商品报"快手小店尚未实测到商品编辑页地址"，
    // 用户看到的是"它去读了一家我没要发的店"。把商品自己的店排前面，这条链路才自洽。
    const ownStoreIds = new Set(links.map(link => link.storeId))
    const orderedStoreIds = [...input.storeIds].sort((a, b) => Number(ownStoreIds.has(b)) - Number(ownStoreIds.has(a)))


    let first: PublishPrecheckResult | null = null
    let firstItemId: string | null = null
    let blocked = 0
    for (const storeId of orderedStoreIds) {
      const store = runtime.getStore(storeId)
      if (!store) {
        runtime.repository.upsertPublishItem({
          jobId, storeId, tier: 'L3', status: 'precheck_failed',
          reasonCode: 'STORE_NOT_FOUND', safeMessage: '店铺不存在或已删除'
        })
        blocked += 1
        continue
      }
      const precheck = precheckPublish({
        product: { id: input.productId, title: product.draft.title, draft: product.draft, draftHash: product.draftHash },
        target: { storeId, storeName: store.name, platform: store.platform, storeStatus: String(store.status ?? 'unknown') },
        existingLinks: links,
        lastValues: runtime.repository.publishDefaults({ platform: store.platform, storeId, productId: input.productId }),
        inFlight: !!runtime.repository.findInflightPublishItem({ productId: input.productId, storeId })
      })
      const itemId = runtime.repository.upsertPublishItem({
        jobId, storeId, tier: precheck.tier,
        status: precheck.nextState,
        filled: { fields: precheck.fields },
        manualFieldCount: precheck.fields.filter(item => item.action === 'leave_empty' || item.action === 'fill_suggest').length,
        reasonCode: precheck.verdict === 'blocked' ? 'PRECHECK_BLOCKED' : 'OK',
        safeMessage: precheck.summary,
        evidence: { idempotencyKey: precheck.idempotencyKey, missingRequired: precheck.missingRequired }
      })
      // 把"平台必填但本地没有"的字段记进**跨次**的必填清单（方案 §7.5 第 3 类）：
      // 下次预检就能在本地补全清单里提示，而不是每次都从零发现。
      const requiredMissing = precheck.fields
        .filter(field => field.action === 'leave_empty' && field.level === 'warning')
        .map(field => ({ field: field.field, label: field.label }))
      if (requiredMissing.length) {
        runtime.repository.recordPlatformRequirements({ platform: store.platform, items: requiredMissing })
      }
      if (!first) { first = precheck; firstItemId = itemId }
      if (precheck.verdict === 'blocked') blocked += 1
    }
    runtime.repository.setPublishJobStatus(jobId, blocked === orderedStoreIds.length ? 'precheck_failed' : 'awaiting_human')

    logMain('info', `[product-publish] 预检完成 product=${input.productId} 店铺=${input.storeIds.length} 阻断=${blocked}`)
    return {
      ok: true,
      jobId,
      itemId: firstItemId,
      precheck: first,
      reasonCode: 'OK',
      safeMessage: first
        ? first.summary
        : '预检完成'
    }
  }

  /**
   * 把页面开到发布页并把这一项推进到 awaiting_human（**人工交接点**）。
   *
   * `fill=true` 时额外做 **L1 代填**（只填实测过锚点的字段，且**每个字段写后回读**）；
   * 无论 fill 与否，**都不点提交、不点保存** —— 本方法里没有任何点击按钮的代码。
   * 未实测发布页的平台走 L3（接力模式）：只打开页面 + 给核对清单。
   */
  async openForHuman(input: { itemId: string; fill?: boolean }): Promise<{ ok: boolean; state: string; tier: string; safeMessage: string; url: string | null; fill: FillOutcome[] }> {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) return { ok: false, state: 'unknown', tier: 'L3', safeMessage: '找不到这条发布项', url: null, fill: [] }
    const store = runtime.getStore(String(item.store_id))
    if (!store) return { ok: false, state: 'precheck_failed', tier: String(item.tier), safeMessage: '店铺不存在或已删除', url: null, fill: [] }
    const tier = publishTierFor(store.platform)
    const profile = PRODUCT_PUBLISH_PROFILES[store.platform] ?? null
    const url = profile?.publishUrl ?? null

    if (!url) {
      // 没有实测到发布入口 → 不猜 URL，如实说明并停在原地
      runtime.repository.upsertPublishItem({
        jobId: String(item.job_id), storeId: String(item.store_id), tier,
        status: 'awaiting_human', reasonCode: 'PUBLISH_ENTRY_NOT_VERIFIED',
        safeMessage: `${store.platform}尚未实测到发布入口地址，请在店铺后台手动进入「发布商品」页面（应用不猜 URL）`
      })
      // 虽然应用不知道可验证的入口 URL，人工仍可能在该店铺页面继续操作；
      // 只要这条发布项还在 awaiting_human，就不能让冷休眠把店铺页面收走。
      retainPublishHumanHold(runtime, store.id, input.itemId)
      return { ok: true, state: 'awaiting_human', tier, safeMessage: `${store.platform}尚未实测到发布入口，请手动进入发布页`, url: null, fill: [] }
    }

    // 发布页导航和表单渲染可能跨越多个切店操作；在人工交接点建立前，
    // 用 external 门禁保护这段异步流程，避免冷休眠中途销毁目标 guest。
    runtime.setStoreLifecycleBlock?.(store.id, 'external', true)
    try {
      let wc = await runtime.waitForStoreWebContents(store.id, 5_000).catch(() => null)
      if (!wc || wc.isDestroyed()) {
        runtime.openStorePage(store.id)
        wc = await runtime.waitForStoreWebContents(store.id, 30_000)
      }
      if (!wc || wc.isDestroyed()) {
        return { ok: false, state: 'filling', tier, safeMessage: '店铺页面不可用，请先打开该店铺', url, fill: [] }
      }

    // **在新标签页里打开发布页**（关键）：
    // 实测（2026-09-30）在旧标签页里导航到 `/shop/goods/entry` 会被平台的"继续编辑"状态
    // 劫持到**上一个商品的编辑页**（URL 变成 `?productId=<上次那个>`）——
    // 那样用户以为在新建、其实在改既有商品，是发布场景里最危险的错。
    // 新标签页没有那个编辑状态，因此从新标签页进。
    const tabId = runtime.createTab(store.id, url)
    let tabWc: WebContents | null = null
    for (let i = 0; i < 40 && !tabWc; i++) {
      tabWc = runtime.getTabWebContents(store.id, tabId)
      if (!tabWc) await delay(300)
    }
    if (!tabWc) {
      // 拿不到新标签页的 webContents 就**不硬来**：如实说明，让用户自己进发布页
      runtime.repository.upsertPublishItem({
        jobId: String(item.job_id), storeId: String(item.store_id), tier,
        status: 'awaiting_human', reasonCode: 'NEW_TAB_UNAVAILABLE',
        safeMessage: '打开发布页的新标签页没就绪，请在浏览器里手动进入「发布商品」页；应用不会替你提交',
        evidence: { publishUrl: url, tier, tabId }
      })
      retainPublishHumanHold(runtime, store.id, input.itemId)
      return { ok: true, state: 'awaiting_human', tier, safeMessage: '新标签页没就绪，请手动进入发布页（应用不会替你提交）', url, fill: [] }
    }
    const page = tabWc

    // 导航到位判据要**比详情页采集更严**：发布页与"既有商品的编辑页"可能共用同一个 pathname。
    // 实测（2026-09-30，微信小店）：`/shop/goods/entry`（新增商品）与
    // `/shop/goods/entry?productId=xxx`（编辑既有商品）**pathname 完全相同**。
    // 只比 origin+pathname 会把"停在别的商品的编辑页"判成"已打开发布页"——
    // 用户可能对着错误商品的页面填一遍然后提交，这是发布场景下最不能出的错。
    //
    // 所以：除了 origin+pathname，**最终 URL 不允许出现目标 URL 里没有的 query 键**
    // （新增商品的目标 URL 没有 query，一旦出现 productId 就说明不是新增页）。
    // 平台的跟踪参数会让我们把"其实到位了"判成"没到位"——这个方向是**安全**的（fail-closed）。
    const target = new URL(url)
    const targetKeys = new Set([...target.searchParams.keys()])
    const evaluate = (current: string): { reached: boolean; reason: string } => {
      let parsed: URL
      try { parsed = new URL(current) } catch { return { reached: false, reason: 'URL 还没成形' } }
      if (parsed.origin !== target.origin || parsed.pathname !== target.pathname) {
        return { reached: false, reason: `停在别的页面（${parsed.pathname}）` }
      }
      const extra = [...parsed.searchParams.keys()].filter(key => !targetKeys.has(key))
      if (extra.length) return { reached: false, reason: `这是既有商品的编辑页（多了 ${extra.join('、')}），不是新增商品页` }
      return { reached: true, reason: '' }
    }

    const attempt = async (hard: boolean): Promise<{ reached: boolean; reason: string; current: string }> => {
      let current = ''
      // hard=true 时先退到 about:blank 再进目标页：实测（2026-09-30）当标签页**已经停在
      // 同一个 pathname**（既有商品的编辑页）时，SPA 会把这次导航吃掉、URL 不变。
      // 先离开再进来能强制走一次真实导航。
      if (hard) {
        try { await page.loadURL('about:blank') } catch { /* 忽略 */ }
        await delay(400)
      }
      try { await page.loadURL(url) } catch { /* 由下面的 URL 轮询判定 */ }
      for (let i = 0; i < 40; i++) {
        if (page.isDestroyed()) return { reached: false, reason: '页面被关闭', current }
        try { current = page.getURL() } catch { return { reached: false, reason: '页面被关闭', current } }
        const verdict = evaluate(current)
        if (verdict.reached) return { reached: true, reason: '', current }
        await delay(500)
      }
      return { reached: false, reason: evaluate(current).reason, current }
    }

    let nav = await attempt(false)
    if (!nav.reached) {
      // 再试一次，这次先退到空白页强制真实导航
      logMain('warn', `[product-publish] 发布页未到位（${nav.reason}），改用硬导航重试一次 current=${nav.current.slice(0, 90)}`)
      await delay(1500)
      if (!page.isDestroyed()) nav = await attempt(true)
    }
    const reached = nav.reached

    // ---------- L1 代填（可选）：只填实测过锚点的字段，每个字段**写后回读** ----------
    //
    // 只在**确认到了发布页**之后才填：在"别的商品的编辑页"上代填等于改错商品（实测踩过），
    // 所以这里用 reached 做前置门禁，宁可少填也不填错页面。
    let fill: FillOutcome[] = []
    const wantFill = input.fill === true && reached
    if (input.fill === true && !reached) {
      fill = [{ field: '*', label: '全部字段', ok: false, written: null, readBack: null, reason: '发布页没确认到位，本次**一个字段都没填**（避免在错误页面上代填）' }]
    } else if (wantFill) {
      // 本地值：与预检同一套口径（单规格用商品级价格库存）
      const draft = runtime.repository.getProduct(String(item.product_id))?.draft
      if (!draft) {
        fill = [{ field: '*', label: '全部字段', ok: false, written: null, readBack: null, reason: '读不到本地商品草稿' }]
      } else {
        // 先等表单**真的渲染出来**：URL 到位 ≠ DOM 就绪（实测新标签页刚打开时表单还是空的）
        const ready = await waitForPublishForm({ wc: page, anchors: WECHAT_FILL_ANCHORS, timeoutMs: 30_000 })
        if (!ready.ready) {
          fill = [{
            field: '*', label: '全部字段', ok: false, written: null, readBack: null,
            reason: `等了 ${Math.round(ready.waitedMs / 1000)} 秒，发布表单始终没渲染出来（一个实测锚点都没找到）——本次一个字段都没填`
          }]
        } else {
          const priceMinor = draft.variants.length === 1 ? draft.variants[0].priceMinor : null
          const stock = draft.variants.length === 1 ? draft.variants[0].stock : null
          fill = await fillPublishFields({
            wc: page,
            profile: null,
            anchors: WECHAT_FILL_ANCHORS,
            values: {
              title: draft.title || null,
              subtitle: draft.subtitle ?? null,
              price: priceMinor == null ? null : (priceMinor / 100).toFixed(2),
              stock: stock == null ? null : String(stock)
            },
            variantCount: draft.variants.length
          })
          logMain('info', `[product-publish] 表单就绪（${Math.round(ready.waitedMs / 1000)}s，找到 ${ready.found.join('/')}）`)
        }
      }
    }

    const filledOk = fill.filter(row => row.ok).map(row => row.label)
    const filledFail = fill.filter(row => !row.ok)
    const fillSummary = wantFill
      ? `已代填 ${filledOk.length} 个字段（${filledOk.join('、') || '无'}）${filledFail.length ? `；${filledFail.length} 个没填：${filledFail.map(row => `${row.label}（${row.reason}）`).join('；')}` : ''}`
      : ''

    runtime.repository.upsertPublishItem({
      jobId: String(item.job_id), storeId: String(item.store_id), tier,
      status: reached ? 'awaiting_human' : 'awaiting_human',
      reasonCode: reached ? 'AWAITING_HUMAN' : 'PUBLISH_PAGE_NOT_READY',
      safeMessage: reached
        ? `已打开${store.platform}发布页（${tier}）${fillSummary ? `，${fillSummary}` : ''}；剩下的由你在页面上确认，应用**不会**替你提交`
        : `发布页没能确认打开（${nav.reason || '页面没到位'}），已停在原地；应用**不会**替你提交，也不会在错误页面上代填`,
      filled: fill.length ? { fill } : null,
      manualFieldCount: fill.filter(row => !row.ok).length,
      evidence: {
        publishUrl: url, reached, tier, hasProfile: hasPublishProfile(store.platform),
        notReachedReason: reached ? null : nav.reason, finalUrl: nav.current.slice(0, 200),
        filledFields: filledOk, fillFailures: filledFail.map(row => ({ field: row.field, reason: row.reason }))
      }
    })
    // 页面已经交给用户：即使切到其它店铺，也要保留发布页直到用户确认或放弃。
    retainPublishHumanHold(runtime, store.id, input.itemId)
    logMain('info', `[product-publish] 打开发布页 store=${store.id} tier=${tier} reached=${reached} 代填=${filledOk.length}（未提交任何内容）`)

    return {
      ok: true,
      state: 'awaiting_human',
      tier,
      fill,
      safeMessage: reached
        ? `已把页面开到发布页（${tier}）。${fillSummary ? fillSummary + '。' : ''}请在页面上核对并自己点提交，提交后回到应用点「我已提交」——应用不会替你点提交`
        : `发布页没能确认打开（${nav.reason || '页面没到位'}）：请检查登录状态、或先在浏览器里手动进入发布页。应用不会替你提交`,
      url
    }
    } finally {
      runtime.setStoreLifecycleBlock?.(store.id, 'external', false)
    }
  }

  /**
   * 开人工确认门禁：**走任务引擎的 `waitForUserConfirmation`**（方案 §7.4 / §7.9）。
   *
   * 为什么用任务引擎而不是自己写个 Promise：门禁那套东西（超时、取消、暂停不打断门禁、
   * 事件广播、审计）在 `task-runner` 里已经实现并验证过；自己再写一份必然分叉，
   * 而且很容易写出"超时自动放行"这种致命的错。
   *
   * 这里建的任务**只有一个步骤**（等确认），不带任何 click/fill 副作用步骤 ——
   * 填充是 `openForHuman` 干的，提交永远由人干，任务引擎在这个流程里**只负责等人**。
   */
  openHumanGate(input: { itemId: string; message: string }): { ok: boolean; runId: string | null; safeMessage: string } {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) return { ok: false, runId: null, safeMessage: '找不到这条发布项' }
    const storeId = String(item.store_id)
    const product = runtime.repository.getProduct(String(item.product_id))
    const store = runtime.getStore(storeId)

    try {
      const task = TaskStore.createTask({
        name: `发布确认：${product?.draft.title?.slice(0, 24) ?? '商品'} → ${store?.name ?? storeId}`,
        storeScope: storeId,
        steps: [{
          type: 'waitForUserConfirmation',
          input: { message: input.message },
          timeoutMs: 3_600_000,   // 门禁可过夜（方案 §7.4）；超时**不自动提交、不自动放弃**
          retryLimit: 0           // 门禁不重试（方案 §7.7：click*/门禁类步骤 retryLimit 强制 0）
        }]
      })
      const { runId } = enqueueRun(task.id, { reason: 'product-publish-gate', storeId })
      // **记下基线**：开门禁这一刻该店已知的平台商品 ID。
      // 回读要靠它判断"哪条是刚发的"——没有基线就只能"存在即确认"，
      // 那会把早就同步过的商品误报成"发布成功"（2026-09-30 实测踩到的假阳性）。
      const baselinePlatformProductIds = runtime.repository.listLinks({ limit: 500 }).rows
        .filter(row => row.storeId === storeId)
        .map(row => row.platformProductId)
      runtime.repository.upsertPublishItem({
        jobId: String(item.job_id), storeId, tier: String(item.tier) as 'L1' | 'L2' | 'L3',
        status: 'awaiting_human', taskRunId: runId,
        reasonCode: 'AWAITING_HUMAN_GATE',
        safeMessage: '已开人工确认门禁：页面上填完并**你自己点提交**之后，回到应用点「我已提交」',
        evidence: { baselinePlatformProductIds, baselineAt: Date.now() }
      })
      // 人工门禁可过夜；在用户明确确认/放弃前，发布页必须保持可恢复。
      retainPublishHumanHold(runtime, storeId, input.itemId)
      logMain('info', `[product-publish] 开人工门禁 item=${input.itemId} run=${runId}（任务引擎只负责等人，不带任何副作用步骤）`)
      return { ok: true, runId, safeMessage: '已开人工确认门禁' }
    } catch (error) {
      return { ok: false, runId: null, safeMessage: `开人工门禁失败：${String((error as Error)?.message || error).slice(0, 160)}` }
    }
  }

  /**
   * 用户点「我已提交」→ 放行门禁（`confirmRun(approved)`），并把发布项推进到 `verifying`。
   *
   * **注意这里只推进状态，不去点任何东西**：提交这个动作是用户自己在浏览器里做的，
   * 应用只是"记下他说的这句话"，然后进入只读回读。
   */
  confirmSubmitted(input: { itemId: string; approved: boolean }): { ok: boolean; state: string; safeMessage: string } {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) {
      releasePublishHumanHoldEverywhere(runtime, input.itemId)
      return { ok: false, state: 'unknown', safeMessage: '找不到这条发布项' }
    }
    const runId = item.task_run_id ? String(item.task_run_id) : null

    if (runId) {
      try { confirmRun(runId, input.approved) } catch (error) {
        // 门禁已经结束（超时/取消）时 confirmRun 会抛 —— 如实说，不假装成功
        logMain('warn', `[product-publish] 放行门禁失败 run=${runId}：${String((error as Error)?.message || error).slice(0, 120)}`)
      }
    }

    const state = input.approved ? 'verifying' : 'discarded'
    runtime.repository.upsertPublishItem({
      jobId: String(item.job_id), storeId: String(item.store_id), tier: String(item.tier) as 'L1' | 'L2' | 'L3',
      status: state, taskRunId: runId ?? undefined,
      reasonCode: input.approved ? 'HUMAN_REPORTED_SUBMITTED' : 'DISCARDED_BY_HUMAN',
      safeMessage: input.approved
        ? '你已确认在平台上提交：接下来只做**只读回读**（回查列表、比对本地），确认前不会改动任何平台数据'
        : '已放弃这次发布：页面留在原处，应用没有、也不会替你提交'
    })
    // 放弃时人工交接已经结束。确认提交后先保留 confirmation 门禁，
    // 让紧接着的只读回读不会在两个 IPC 调用之间被冷休眠打断；verifyAfterSubmit 完成后再释放。
    if (!input.approved) releasePublishHumanHold(runtime, String(item.store_id), input.itemId)
    logMain('info', `[product-publish] 人工答复 item=${input.itemId} approved=${input.approved} → ${state}`)
    return {
      ok: true,
      state,
      safeMessage: input.approved
        ? '已进入回读校验（只读）：回查平台列表比对本地，确认发布是否真的成功'
        : '已放弃这次发布（应用不会替你提交）'
    }
  }

  /**
   * §7.5 回读校验（**只读**）：回查平台商品列表，看这个标题是不是真的出现了。
   *
   * 双证据口径（方案 §7.4）：**平台列表里查到 + 本地台账记下** 才算 `confirmed`；
   * 只查到一个（或查到两个同标题，疑似重复提交）→ `needs_review`，摆给人看。
   * 这一版只做"回查 + 判定"，不自动写 `product_platform_links`（写入要等用户确认）。
   */
  async verifyAfterSubmit(input: { itemId: string; resync?: boolean }): Promise<{ ok: boolean; state: string; safeMessage: string; matched: number }> {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) return { ok: false, state: 'unknown', safeMessage: '找不到这条发布项', matched: 0 }
    const storeId = String(item.store_id)
    // 只有 confirmSubmitted(true) 后的 verifying/后续状态才结束人工交接。
    // 即使本地商品已被删除，也不能让此前的确认门禁永久残留。
    const shouldReleaseHumanHold = ['verifying', 'confirmed', 'needs_review'].includes(String(item.status))
    const product = runtime.repository.getProduct(String(item.product_id))
    if (!product) {
      if (shouldReleaseHumanHold) releasePublishHumanHold(runtime, storeId, input.itemId)
      return { ok: false, state: 'needs_review', safeMessage: '本地商品已被删除，无法比对', matched: 0 }
    }

    runtime.setStoreLifecycleBlock?.(storeId, 'external', true)
    try {
    // 先做一次**只读同步**去平台上回查（默认做）：只查本地台账会拿到过时数据，
    // 那样"没找到新增"可能只是"还没同步"，而不是"没发成功"。
    let syncNote = ''
    if (input.resync !== false) {
      try {
        const sync = await productSyncService.syncStore({ storeId, trigger: 'manual' })
        syncNote = sync.status === 'SUCCEEDED'
          ? `（已回查平台：拉到 ${sync.fetchedCount} 条）`
          : `（回查平台没成功：${sync.safeMessage}）`
      } catch (error) {
        syncNote = `（回查平台失败：${String((error as Error)?.message || error).slice(0, 80)}）`
      }
    }

    const evidence = parseEvidence(item.evidence_json)
    const baseline: string[] = Array.isArray(evidence.baselinePlatformProductIds)
      ? (evidence.baselinePlatformProductIds as string[])
      : []
    const current = runtime.repository.listLinks({ limit: 500 }).rows
      .filter(row => row.storeId === storeId)
      .map(row => ({ platformProductId: row.platformProductId, title: row.platformTitle ?? '' }))

    const readback = evaluateReadback({ baselinePlatformProductIds: baseline, current, expectedTitle: product.draft.title })

    runtime.repository.upsertPublishItem({
      jobId: String(item.job_id), storeId, tier: String(item.tier) as 'L1' | 'L2' | 'L3',
      status: readback.state, taskRunId: item.task_run_id ? String(item.task_run_id) : undefined,
      platformProductId: readback.matchedPlatformProductIds[0] ?? null,
      reasonCode: readback.reasonCode,
      safeMessage: readback.safeMessage + syncNote,
      evidence: {
        baselinePlatformProductIds: baseline,
        baselineCount: baseline.length,
        newPlatformProductIds: readback.newPlatformProductIds,
        matchedPlatformProductIds: readback.matchedPlatformProductIds,
        resynced: input.resync !== false
      }
    })
    logMain('info', `[product-publish] 回读 item=${input.itemId} state=${readback.state} 基线=${baseline.length} 新增=${readback.newPlatformProductIds.length} 匹配=${readback.matchedPlatformProductIds.length}`)
    return { ok: true, state: readback.state, safeMessage: readback.safeMessage + syncNote, matched: readback.matchedPlatformProductIds.length }
    } finally {
      // 回读完成（成功、失败或异常）后，发布人工交接生命周期结束，
      // 店铺重新回到正常的当前/温缓存/冷休眠策略。
      if (shouldReleaseHumanHold) releasePublishHumanHold(runtime, storeId, input.itemId)
      runtime.setStoreLifecycleBlock?.(storeId, 'external', false)
    }
  }

  /**
   * 回读"**用户实际填的值**"（方案 §7.5 第 2 类）：读页面上当前的字段值，与本地对比，产出建议。
   *
   * **只读**：只打开商品的编辑页并读 DOM，不改页面、不点任何按钮、**不写任何库**。
   * 落库必须由用户逐条确认（见 `acceptSuggestion`）——方案原话是"不自动改，
   * 避免'这次特批'变成默认值"。
   */
  async readbackFields(input: { itemId: string }): Promise<{
    ok: boolean
    suggestions: ReadbackSuggestion[]
    counts: ReadbackComparison['counts'] | null
    safeMessage: string
    readFields: string[]
    missingFields: string[]
  }> {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) return { ok: false, suggestions: [], counts: null, safeMessage: '找不到这条发布项', readFields: [], missingFields: [] }
    const store = runtime.getStore(String(item.store_id))
    if (!store) return { ok: false, suggestions: [], counts: null, safeMessage: '店铺不存在或已删除', readFields: [], missingFields: [] }
    const product = runtime.repository.getProduct(String(item.product_id))
    if (!product) return { ok: false, suggestions: [], counts: null, safeMessage: '本地商品已被删除', readFields: [], missingFields: [] }

    runtime.setStoreLifecycleBlock?.(store.id, 'external', true)
    let readbackTabId: string | null = null
    try {
    // 读的是**商品的编辑页**（`?productId=`）：实测编辑页才把短标题/品牌/类目/价格/库存都渲染出来，
    // 新增商品页只有标题。回读的目的正是"看用户到底填了什么"，所以要读字段齐全的那一页。
    // 平台商品 ID 从**本地商品已归并的那条平台商品**取。
    // ⚠️ 不能用 `publish_items.platform_product_id`：那一列是**回读成功后**才填的，
    // 回读之前它一定是 NULL（实测踩到：于是回读永远说"还没有平台商品 ID"，一步都走不动）。
    const linked = runtime.repository.listLinks({ limit: 500 }).rows
      .find(row => row.productId === String(item.product_id) && row.storeId === String(item.store_id))
    const linkId = linked ? linked.platformProductId : null
    const url = linkId ? detailUrlFor(store.platform, linkId) : null
    if (!url) {
      return {
        ok: false, suggestions: [], counts: null,
        safeMessage: `${store.platform}尚未实测到商品编辑页地址（或这个本地商品还没归并平台商品），无法回读`,
        readFields: [], missingFields: []
      }
    }

    // **在新标签页里打开编辑页**（关键，与 openForHuman 是同一条实测结论）：
    //
    // 这里原来复用店铺已有标签页 + `loadURL`，有两个问题（2026-10-01 实测）：
    //   ① 实测过：在旧标签页里导航到 `/shop/goods/entry` 会被平台的"继续编辑"状态
    //      劫持到**上一个商品的编辑页**（URL 变成 `?productId=<上次那个>`）→ 回读会去读**别的商品**，
    //      而且表现为"等了 31 秒表单没渲染出来"（因为锚点根本不在那个页面上）；
    //   ② 复用已有标签页会**劫持用户正在看的页面** —— 用户开着店铺后台，点一下回读，页面就被导航走了。
    // 所以和 openForHuman 一样：**从新标签页进**。
    // ⚠️ **先确保店铺浏览器就绪**（照 openForHuman 的写法，2026-10-01 实测踩到两次）：
    //   ① 浏览器没开就 `createTab` → 抛 `Error: Browser not open for this store`；
    //   ② 只 `openStorePage` + 短延迟也不行 —— 新标签页的 webContents 拿不到，
    //      回读会报"打不开商品编辑页（新标签页没就绪）"。
    // 正确顺序：先等已有 webContents → 没有就 openStorePage → **再等最多 30 秒** → 才 createTab。
    let storeWc = await runtime.waitForStoreWebContents(store.id, 5_000).catch(() => null)
    // ⚠️ **无论 webContents 在不在，都要 `openStorePage`**（2026-10-01 实测）：
    // "webContents 存在" ≠ "店铺窗口已打开"。窗口没显示时 `createTab` 建出来的标签页
    // **webContents 不会被实例化**，于是轮询 36 秒都拿不到，回读报"新标签页没就绪"。
    // 所以这里不判断，直接打开一次（幂等：已经开着就是把它激活）。
    runtime.openStorePage(store.id)
    if (!storeWc || storeWc.isDestroyed()) {
      storeWc = await runtime.waitForStoreWebContents(store.id, 30_000).catch(() => null)
    }
    if (!storeWc || storeWc.isDestroyed()) {
      return { ok: false, suggestions: [], counts: null, safeMessage: '店铺页面不可用，请先打开该店铺', readFields: [], missingFields: [] }
    }

    readbackTabId = runtime.createTab(store.id, url)
    let wc: WebContents | null = null
    // 轮询放宽到 36 秒：实测新标签页的 webContents 有时 12 秒还没就绪（页面在加载微信编辑页）
    for (let i = 0; i < 120 && !wc; i++) {
      wc = runtime.getTabWebContents(store.id, readbackTabId)
      if (!wc) await delay(300)
    }
    if (!wc || wc.isDestroyed()) {
      return { ok: false, suggestions: [], counts: null, safeMessage: '打不开商品编辑页（新标签页没就绪）——本次没有读到任何字段', readFields: [], missingFields: [] }
    }
    const ready = await waitForPublishForm({ wc, anchors: WECHAT_FILL_ANCHORS, timeoutMs: 30_000 })
    if (!ready.ready) {
      return {
        ok: false, suggestions: [], counts: null,
        safeMessage: `等了 ${Math.round(ready.waitedMs / 1000)} 秒，编辑页表单没渲染出来，无法回读`,
        readFields: [], missingFields: []
      }
    }

    const read = await readPublishPageFieldValues({ wc, anchors: WECHAT_FILL_ANCHORS })
    const priceMinor = product.draft.variants.length === 1 ? product.draft.variants[0].priceMinor : null
    const stock = product.draft.variants.length === 1 ? product.draft.variants[0].stock : null
    const comparison = compareReadbackFields({
      local: {
        title: product.draft.title || null,
        subtitle: product.draft.subtitle ?? null,
        price: priceMinor == null ? null : (priceMinor / 100).toFixed(2),
        stock: stock == null ? null : String(stock)
      },
      platformValues: read.values
    })

    // 建议存进台账（evidence 浅合并，不会抹掉基线），供界面显示与用户逐条确认
    runtime.repository.upsertPublishItem({
      jobId: String(item.job_id), storeId: store.id, tier: String(item.tier) as 'L1' | 'L2' | 'L3',
      status: String(item.status),
      taskRunId: item.task_run_id ? String(item.task_run_id) : undefined,
      evidence: { readbackSuggestions: comparison.suggestions, readbackCounts: comparison.counts, readbackAt: Date.now() }
    })
    logMain('info', `[product-publish] 回读字段 item=${input.itemId} 读到=${read.found.length} 缺失=${read.missing.length} 建议=${comparison.actionable.length}`)

    return {
      ok: true,
      suggestions: comparison.suggestions,
      counts: comparison.counts,
      safeMessage: comparison.actionable.length
        ? `回读到 ${comparison.actionable.length} 项需要你决定（${comparison.counts.suggestDefault} 项建议存为默认值、${comparison.counts.suggestWriteback} 项与本地不一致）—— 应用不会自动改`
        : '回读完成：页面上填的值与本地一致，无需处理',
      readFields: read.found,
      missingFields: read.missing
    }
    } finally {
      if (readbackTabId) {
        try { runtime.closeTab?.(store.id, readbackTabId) } catch { /* 页面已被用户关闭 */ }
      }
      runtime.setStoreLifecycleBlock?.(store.id, 'external', false)
    }
  }

  /**
   * 用户确认一条回读建议 → 落库（方案 §7.5）。
   *
   * `kind` 决定落到哪里：
   *   · `suggest_default`   → 写 `product_platform_defaults`（source=`human_readback`），下次预检"用上次选择"就能用上；
   *   · `suggest_writeback` → 把平台上的值**回写本地商品草稿**（用户明确点了才改）。
   * `same` / `only_local` 没有可落库的动作，直接如实拒绝。
   */
  acceptSuggestion(input: { itemId: string; field: string; kind: string }): { ok: boolean; safeMessage: string } {
    const runtime = this.runtimeFactory()
    const item = runtime.repository.listPublishItems({ limit: 200 }).find(row => String(row.id) === input.itemId)
    if (!item) return { ok: false, safeMessage: '找不到这条发布项' }
    const store = runtime.getStore(String(item.store_id))
    if (!store) return { ok: false, safeMessage: '店铺不存在或已删除' }

    const evidence = parseEvidence(item.evidence_json)
    const suggestions = Array.isArray(evidence.readbackSuggestions) ? (evidence.readbackSuggestions as ReadbackSuggestion[]) : []
    const suggestion = suggestions.find(row => row.field === input.field && row.kind === input.kind)
    if (!suggestion) return { ok: false, safeMessage: '这条建议已经过期了，请重新回读' }

    if (input.kind === 'suggest_default') {
      runtime.repository.savePublishDefault({
        platform: store.platform,
        productId: String(item.product_id),
        fieldKey: suggestion.defaultKey,
        fieldValue: suggestion.platformValue,
        source: 'human_readback'
      })
      // 用户在平台上填了它 → 说明这一项平台是要的，记进必填清单（下次预检会提示）
      runtime.repository.recordPlatformRequirements({
        platform: store.platform,
        items: [{ field: suggestion.defaultKey, label: suggestion.label }]
      })
      return { ok: true, safeMessage: `已把「${suggestion.label}」存为默认值（下次发布预检会用上）` }
    }

    if (input.kind === 'suggest_writeback') {
      const product = runtime.repository.getProduct(String(item.product_id))
      if (!product) return { ok: false, safeMessage: '本地商品已被删除' }
      const draft = { ...product.draft }
      if (suggestion.field === 'title') {
        draft.title = suggestion.platformValue ?? draft.title
      } else if (suggestion.field === 'subtitle') {
        draft.subtitle = suggestion.platformValue
      } else if (suggestion.field === 'price' || suggestion.field === 'stock') {
        if (product.draft.variants.length !== 1) {
          return { ok: false, safeMessage: '本地是多规格商品，回写价格/库存要按规格逐个确认（本轮只支持单规格）' }
        }
        const numeric = Number(String(suggestion.platformValue ?? '').replace(/[^\d.]/g, ''))
        if (!Number.isFinite(numeric)) return { ok: false, safeMessage: '平台上的值不是数字，没法回写' }
        draft.variants = [{
          ...product.draft.variants[0],
          ...(suggestion.field === 'price' ? { priceMinor: Math.round(numeric * 100) } : { stock: Math.round(numeric) })
        }]
      } else {
        return { ok: false, safeMessage: `「${suggestion.label}」暂时不支持回写（只有标题/短标题/单规格价格库存可以）` }
      }
      runtime.repository.updateProduct({ productId: String(item.product_id), draft, draftHash: localProductDraftHash(draft) })
      return { ok: true, safeMessage: `已把「${suggestion.label}」按平台上的值回写到本地（草稿指纹已更新）` }
    }

    return { ok: false, safeMessage: '这一条没有可落库的动作（一致或只有本地有值）' }
  }

  // ---------------------------------------------------------------- 批量编排（M5，方案 §7.8）

  /**
   * 建一次批量发布。
   *
   * **只建台账、只算计划**：这一步不预检、不开页面、不填字段、更不提交。
   * 逐店的预检与推进由用户按"当前店铺"往前走（方案 §7.8：一次只打开一个店铺）。
   *
   * 每个商品一个 job（job 的语义就是"一个商品发到一批店铺"），用 `batch_id` 归组。
   */
  createBatch(input: { productIds: string[]; storeIds: string[] }): {
    ok: boolean
    batchId: string | null
    errors: string[]
    progress: BatchProgress | null
  } {
    const runtime = this.runtimeFactory()
    const plan = planBatch(input)
    if (!plan.ok) return { ok: false, batchId: null, errors: plan.errors, progress: null }

    // 商品必须存在（不存在就明确报出来，不静默跳过）
    const missing = plan.items
      .map(item => item.productId)
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter(id => !runtime.repository.getProduct(id))
    if (missing.length) {
      return { ok: false, batchId: null, errors: [`有 ${missing.length} 个本地商品不存在或已删除，请刷新后重试`], progress: null }
    }

    const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    for (const productId of Array.from(new Set(plan.items.map(item => item.productId)))) {
      const product = runtime.repository.getProduct(productId)!
      const jobId = runtime.repository.createPublishJob({ productId, draftHash: product.draftHash, batchId, now })
      for (const item of plan.items.filter(row => row.productId === productId)) {
        const store = runtime.getStore(item.storeId)
        runtime.repository.upsertPublishItem({
          jobId, storeId: item.storeId,
          tier: store ? publishTierFor(store.platform) : 'L3',
          status: 'pending',
          reasonCode: 'BATCH_QUEUED',
          safeMessage: '已排入批量队列（还没开始；轮到这家店时再预检）',
          now
        })
      }
    }
    const progress = this.batchProgressFor({ batchId }).progress
    logMain('info', `[product-publish] 建批量 batch=${batchId} 商品=${plan.totals.products} 店铺=${plan.totals.stores} 项=${plan.totals.items}（只建台账，未提交任何内容）`)
    return { ok: true, batchId, errors: [], progress }
  }

  /** 批次进度：**三个数**（已完成/待人工/失败），不是一个百分比。 */
  batchProgressFor(input: { batchId: string }): {
    progress: BatchProgress | null
    items: Array<{ itemId: string; productId: string; storeId: string; status: string; safeMessage: string | null }>
  } {
    const runtime = this.runtimeFactory()
    const rows = runtime.repository.listBatchItems(input.batchId)
    if (!rows.length) return { progress: null, items: [] }
    // ⚠️ 这里曾经写"台账 status 与规则层同名，直接映射"并做 as 强转 —— **那句话是错的**：
    // 台账里的失败叫 precheck_failed（规则层统计 failed）、"正在跑"叫 prechecking/filling/…
    // （规则层是 running）。强转的后果是**失败项被漏统计** → 进度显示"失败 0"而实际有失败。
    // 现在走显式映射（见 @shared/product-status），认不出来的状态**按 failed 处理**。
    const planItems: BatchPlanItem[] = rows.map((row, index) => ({
      productId: row.productId,
      storeId: row.storeId,
      order: index,
      state: toBatchItemState(row.status)
    }))
    return {
      progress: batchProgress(planItems),
      items: rows.map(row => ({ itemId: row.itemId, productId: row.productId, storeId: row.storeId, status: row.status, safeMessage: row.safeMessage }))
    }
  }

  /** 「跳过这家先做下一家」：只把该店**还没开始**的项标成 skipped（已等人工的不动）。 */
  skipStore(input: { batchId: string; storeId: string }): { ok: boolean; skipped: number; safeMessage: string } {
    const runtime = this.runtimeFactory()
    const skipped = runtime.repository.skipStoreInBatch({ batchId: input.batchId, storeId: input.storeId })
    const progress = this.batchProgressFor({ batchId: input.batchId }).progress
    logMain('info', `[product-publish] 跳过店铺 batch=${input.batchId} store=${input.storeId} 跳过=${skipped}`)
    return {
      ok: true,
      skipped,
      safeMessage: skipped
        ? `已跳过这家店还没开始的 ${skipped} 条（都没有提交，之后可以重新发起）；${progress?.summary ?? ''}`
        : `这家店没有"还没开始"的项可跳过（${progress?.summary ?? ''}）`
    }
  }

  /**
   * 「全部暂停」：把批次里"正在跑"的退回未开始。
   * **已经在等你确认的保持等待** —— 人工交接点不该被暂停冲掉（与规则层 `abortBatch` 一致）。
   */
  abortBatch(input: { batchId: string }): { ok: boolean; aborted: number; safeMessage: string } {
    const runtime = this.runtimeFactory()
    const aborted = runtime.repository.abortBatchInProgress({ batchId: input.batchId })
    const progress = this.batchProgressFor({ batchId: input.batchId }).progress
    logMain('info', `[product-publish] 暂停批次 batch=${input.batchId} 退回=${aborted}`)
    return {
      ok: true,
      aborted,
      safeMessage: aborted
        ? `已暂停：${aborted} 条"正在跑"的退回未开始（都没有提交，之后可以重新发起）；已经在等你确认的保持等待；${progress?.summary ?? ''}`
        : `本批次没有"正在跑"的项可暂停 —— 这个设计里发布是**人工驱动**的，没有自动跑的中间态（已经在等你确认的不会被冲掉）。如果你要的是"把还没开始的都停掉"，那需要另一个动作；${progress?.summary ?? ''}`
    }
  }

  /** 下次发布前的**本地补全清单**（方案 §7.5 第 3 类）：跨次记住的平台必填项 + 本地还没有。 */  completionChecklistFor(input: { productId: string; storeId: string }): Array<{ field: string; label: string; reason: string }> {
    const runtime = this.runtimeFactory()
    const store = runtime.getStore(input.storeId)
    const product = runtime.repository.getProduct(input.productId)
    if (!store || !product) return []
    const requirements = runtime.repository.listPlatformRequirements(store.platform)
    const priceMinor = product.draft.variants.length === 1 ? product.draft.variants[0].priceMinor : null
    const stock = product.draft.variants.length === 1 ? product.draft.variants[0].stock : null
    return completionChecklist({
      requirements,
      platform: store.platform,
      local: {
        title: product.draft.title || null,
        subtitle: product.draft.subtitle ?? null,
        price: priceMinor == null ? null : String(priceMinor),
        stock: stock == null ? null : String(stock),
        category: product.draft.localCategory ?? null,
        brand: product.draft.brand ?? null
      }
    })
  }
}

/** 解析台账里的 evidence_json（坏数据返回空对象，不抛）。 */
function parseEvidence(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export const productPublishService = new ProductPublishService()
