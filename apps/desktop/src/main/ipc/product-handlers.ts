/**
 * 商品管理 IPC（Renderer 只能传店铺 ID 与有限分页参数）。
 *
 * 与订单/经营指标同一条边界：**Renderer 不碰数据库、不碰平台页面**，
 * 所有判断（登录门禁、平台是否已实测、字段解析）都在 Main 里做完。
 */

import type { IpcMainInvokeEvent } from 'electron'
import { logMain } from '../services/logger'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import {
  productLibraryIdInputSchema,
  productLibraryListQuerySchema,
  productLibraryMergeInputSchema,
  productLibrarySaveAsInputSchema,
  productLibrarySaveInputSchema,
  productLibraryUnmergeInputSchema,
  productDetailCollectInputSchema,
  productPublishAcceptInputSchema,
  productPublishBatchCreateInputSchema,
  productPublishBatchProgressInputSchema,
  productPublishBatchSkipStoreInputSchema,
  productMediaQueueInputSchema,
  productPublishChecklistInputSchema,
  productPublishConfirmInputSchema,
  productPublishGateInputSchema,
  productPublishIdInputSchema,
  productPublishItemsQuerySchema,
  productPublishOpenInputSchema,
  productPublishPreflightInputSchema,
  productListQuerySchema,
  productSyncInputSchema
} from '@shared/schemas/product'
import { productSyncService } from '../products/product-sync-service'
import { productDetailService } from '../products/product-detail-service'
import { productPublishService } from '../products/product-publish-service'
import { ProductRepository } from '../products/product-repository'
import { ProductLibraryService } from '../products/product-library-service'
import { ProductMediaService } from '../products/product-media-service'
import * as ShopSessionManager from '../browser/shop-session-manager'
import * as StoreManager from '../stores/store-manager'
import { getDatabase } from '../db/database'

function requestId(): string { return randomUUID() }
function ok<T>(data: T, requestIdValue: string): IPCResult<T> { return { ok: true, data, requestId: requestIdValue } }
function fail(code: string, message: string, requestIdValue: string): IPCResult {
  return { ok: false, error: { code, message: message.slice(0, 300) }, requestId: requestIdValue }
}
function inputError(requestIdValue: string): IPCResult {
  return fail('INVALID_ARGUMENT', '商品请求参数不合法', requestIdValue)
}
function serviceError(error: unknown, requestIdValue: string): IPCResult {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'STORE_NOT_FOUND') return fail('STORE_NOT_FOUND', '店铺不存在或已删除', requestIdValue)
  if (code === 'APP_LOCKED') return fail('APP_LOCKED', '应用已锁定', requestIdValue)
  if (code === 'INVALID_ARGUMENT') return fail('INVALID_ARGUMENT', '商品请求参数不合法', requestIdValue)
  // ⚠️ **兜底也要把真实异常记下来**（2026-10-01 实测踩到）：
  // 这里原来只返回一句"商品操作失败"，既没有日志也没有堆栈 —— 于是
  // 「回读页面实际值」抛异常时，界面上只有"商品操作失败"，日志里什么都没有，
  // 排查时**一点线索都没有**（我为此多花了一轮）。兜底可以给用户一句笼统的话，
  // 但**必须**把真实原因留在日志里，否则等于系统性丢失错误信息。
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
  logMain('error', `[product-ipc] 服务抛异常 requestId=${requestIdValue}：${String(stack).slice(0, 800)}`)
  return fail('INTERNAL_ERROR', '商品操作失败', requestIdValue)
}

const handle = familyHandle('商品')

export function registerProductHandlers(): void {
  handle(IPC_CHANNELS.PRODUCT_SYNC, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productSyncInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await productSyncService.syncStore(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productListQuerySchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      const repository = new ProductRepository(getDatabase())
      return ok({ ...repository.listLinks(parsed.data), counts: repository.countByStore() }, rid)
    } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_SYNC_RUNS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productListQuerySchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      const repository = new ProductRepository(getDatabase())
      // 界面要的是"每家店最近一次同步"：失败信息只挂最近一次，
      // 不用"早就被后续成功覆盖的旧失败"吓人（发票中心踩过的坑）。
      return ok({ rows: repository.countByStore().map(row => ({ ...row, latestRun: repository.latestSyncRun(row.storeId) })) }, rid)
    } catch (error) { return serviceError(error, rid) }
  })

  // ---------------------------------------------------------------- 本地商品库（M2）

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryListQuerySchema.safeParse(raw ?? {})
    if (!parsed.success) return inputError(rid)
    try {
      return ok(new ProductRepository(getDatabase()).listProducts(parsed.data), rid)
    } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_GET, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(library().get(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_SAVE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibrarySaveInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(library().save(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_SAVE_AS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibrarySaveAsInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(library().saveAsLocal(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_MERGE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryMergeInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      library().merge(parsed.data)
      return ok({ merged: true }, rid)
    } catch (error) {
      // UNIQUE(store_id, product_id) 冲突是**预期内的业务约束**，给用户看得懂的话
      const message = String((error as Error)?.message || error)
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        return fail('MERGE_CONFLICT', '同一店铺里这个本地商品已经挂了一个平台商品（防止发重），请先取消原来的归并', rid)
      }
      return serviceError(error, rid)
    }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_UNMERGE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryUnmergeInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { library().unmerge(parsed.data); return ok({ unmerged: true }, rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_LIBRARY_REMOVE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { library().remove(parsed.data); return ok({ removed: true }, rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_MEDIA_LOCALIZE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productLibraryIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await library().localizeMedia(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_DETAIL_COLLECT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productDetailCollectInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await productDetailService.collect(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  // ---------------------------------------------------------------- 发布（M3）
  //
  // 这三个频道**没有任何提交能力**：预检只算不写平台，open 只把页面开到发布页，
  // items 是只读台账。方案 §7.9 的"不可配置的人工边界"就落在这里 ——
  // 即使渲染层被攻破，也没有一个 IPC 能让应用替你点提交。

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_PREFLIGHT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishPreflightInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.preflight(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_OPEN, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishOpenInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await productPublishService.openForHuman(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_ITEMS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishItemsQuerySchema.safeParse(raw ?? {})
    if (!parsed.success) return inputError(rid)
    try {
      return ok({ rows: new ProductRepository(getDatabase()).listPublishItems(parsed.data) }, rid)
    } catch (error) { return serviceError(error, rid) }
  })

  // 人工确认门禁：**只开/放行门禁与只读回读**。
  // `confirm` 的 approved 是"用户说他已在平台上提交了"，**不是"让应用去提交"** ——
  // 这三个频道里同样没有任何"替用户点提交"的能力（方案 §7.9 的人工边界）。

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_OPEN_GATE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishGateInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      return ok(productPublishService.openHumanGate({
        itemId: parsed.data.itemId,
        message: parsed.data.message ?? '请在平台上核对发布页内容；提交由你自己点。提交完成后回到应用点「我已提交」。'
      }), rid)
    } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_CONFIRM, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishConfirmInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.confirmSubmitted(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_VERIFY, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await productPublishService.verifyAfterSubmit(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  // 回读闭环（M4，方案 §7.5）：`readback` **只读页面**产出建议（不写库），
  // `accept` 是**用户逐条确认之后**才落库 —— 规则层不落库，这一层也只落用户点过的那一条。

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_READBACK, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await productPublishService.readbackFields(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_ACCEPT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishAcceptInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.acceptSuggestion(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_CHECKLIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishChecklistInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      return ok({ items: productPublishService.completionChecklistFor(parsed.data) }, rid)
    } catch (error) { return serviceError(error, rid) }
  })

  // 批量编排（M5，方案 §7.8）：create 只建台账、progress 只读、skipStore 只改"还没开始"的项。
  // 三个频道同样**没有任何提交能力** —— 批量下的提交仍然只能由人在浏览器里点。

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_CREATE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishBatchCreateInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.createBatch(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_PROGRESS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishBatchProgressInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.batchProgressFor(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_SKIP_STORE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishBatchSkipStoreInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.skipStore(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  // 「全部暂停」：只把"正在跑"的退回未开始；已经在等人工的保持等待。
  handle(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_ABORT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productPublishBatchProgressInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(productPublishService.abortBatch(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  // 图片本地化队列与保留策略：scan 只算、run 逐张下（复用已验证的下载路径）、
  // orphans **只判定不删**、cleanup 是**用户确认后**才删（且只删 mediaRoot 内、不在表里的文件）。

  handle(IPC_CHANNELS.PRODUCT_MEDIA_QUEUE_SCAN, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productMediaQueueInputSchema.safeParse(raw ?? {})
    if (!parsed.success) return inputError(rid)
    try { return ok(library().scanMediaQueue(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_MEDIA_QUEUE_RUN, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = productMediaQueueInputSchema.safeParse(raw ?? {})
    if (!parsed.success) return inputError(rid)
    try { return ok(await library().runMediaQueue(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_MEDIA_ORPHANS, async (_event: IpcMainInvokeEvent, _raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    try { return ok(await library().scanOrphanMedia(), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.PRODUCT_MEDIA_CLEANUP, async (_event: IpcMainInvokeEvent, _raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    try { return ok(await library().cleanupOrphanMedia(), rid) } catch (error) { return serviceError(error, rid) }
  })
}

/** 懒建服务实例：图片根目录要等 Electron ready 之后才拿得到（`app.getPath('userData')`）。 */
function library(): ProductLibraryService {
  const mediaRoot = join(app.getPath('userData'), 'product-media')
  return new ProductLibraryService(
    new ProductRepository(getDatabase()),
    new ProductMediaService(() => ({
      ensureSession: ShopSessionManager.ensureSession,
      getStore: storeId => StoreManager.getStore(storeId),
      repository: new ProductRepository(getDatabase()),
      mediaRoot
    }))
  )
}
