import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import {
  salesMetricsCollectionInputSchema,
  salesMetricsHealthQuerySchema,
  salesMetricsLatestQuerySchema,
  salesMetricsPlanGetQuerySchema,
  salesMetricsPlanListQuerySchema,
  salesMetricsPlanPauseSchema,
  salesMetricsPlanResumeSchema,
  salesMetricsPlanRunNowSchema,
  salesMetricsPlanUpdateSchema,
  salesMetricsProductQuerySchema,
  salesMetricsQuerySchema,
  salesMetricsRunsQuerySchema
} from '@shared/schemas/sales-metrics'
import { salesMetricsCollectionService } from '../sales-metrics/sales-metrics-collection-service'
import {
  getPlanView,
  healthSnapshot,
  listPlanViews,
  listRuns,
  pausePlan,
  requestImmediateRun,
  resumePlan,
  syncPlansNow,
  updatePlanSettings
} from '../sales-metrics/sales-metrics-scheduler'

function requestId(): string { return randomUUID() }
function ok<T>(data: T, requestIdValue: string): IPCResult<T> { return { ok: true, data, requestId: requestIdValue } }
function fail(code: string, message: string, requestIdValue: string): IPCResult { return { ok: false, error: { code, message: message.slice(0, 300) }, requestId: requestIdValue } }
function inputError(id: string): IPCResult { return fail('INVALID_ARGUMENT', '经营数据请求参数不合法', id) }
function serviceError(error: unknown, id: string): IPCResult {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'STORE_NOT_FOUND') return fail('STORE_NOT_FOUND', '店铺不存在或已删除', id)
  if (code === 'APP_LOCKED') return fail('APP_LOCKED', '应用已锁定', id)
  if (code === 'INVALID_ARGUMENT') return fail('INVALID_ARGUMENT', '经营数据请求参数不合法', id)
  return fail('INTERNAL_ERROR', '经营数据操作失败', id)
}

/** 计划操作：店铺不存在/计划不存在都要给可区分的错误码，前端才知道该刷新列表还是提示。 */
function planError(reasonCode: string, id: string): IPCResult {
  if (reasonCode === 'STORE_NOT_FOUND') return fail('STORE_NOT_FOUND', '店铺不存在或已删除', id)
  if (reasonCode === 'PLAN_NOT_FOUND') return fail('PLAN_NOT_FOUND', '该店铺还没有采集计划（新店铺会在 30 秒内自动建计划）', id)
  if (reasonCode === 'ALREADY_RUNNING') return fail('ALREADY_RUNNING', '该店铺正在采集，请等待本次结束', id)
  return fail('INTERNAL_ERROR', '计划操作失败', id)
}

const handle = familyHandle('经营数据')

export function registerSalesMetricsHandlers(): void {
  handle(IPC_CHANNELS.SALES_METRICS_COLLECT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsCollectionInputSchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try { return ok(await salesMetricsCollectionService.collect(parsed.data), id) } catch (error) { return serviceError(error, id) }
  })
  handle(IPC_CHANNELS.SALES_METRICS_LATEST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsLatestQuerySchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try { return ok(salesMetricsCollectionService.latest(parsed.data.storeId, parsed.data.periodType), id) } catch (error) { return serviceError(error, id) }
  })
  handle(IPC_CHANNELS.SALES_METRICS_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsQuerySchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try { return ok(salesMetricsCollectionService.list(parsed.data), id) } catch (error) { return serviceError(error, id) }
  })
  handle(IPC_CHANNELS.SALES_METRICS_PRODUCTS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsProductQuerySchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try { return ok(salesMetricsCollectionService.products(parsed.data), id) } catch (error) { return serviceError(error, id) }
  })
  handle(IPC_CHANNELS.SALES_METRICS_TOP_PRODUCTS, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsProductQuerySchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try { return ok(salesMetricsCollectionService.topProducts(parsed.data), id) } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanListQuerySchema.safeParse(raw ?? {}); if (!parsed.success) return inputError(id)
    try {
      const now = Date.now()
      syncPlansNow()
      const views = listPlanViews(now)
      const filtered = views.filter(view =>
        (!parsed.data.storeId || view.storeId === parsed.data.storeId) &&
        (!parsed.data.platform || view.platform === parsed.data.platform))
      return ok({ computedAt: now, items: filtered, health: healthSnapshot(now) }, id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_GET, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanGetQuerySchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try {
      const view = getPlanView(parsed.data.storeId)
      return view ? ok(view, id) : planError('PLAN_NOT_FOUND', id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_UPDATE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanUpdateSchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try {
      // 只允许改启用状态与周期；周期受 schema 限幅（1 分钟～24 小时），不接受任意毫秒。
      const changed = updatePlanSettings(parsed.data.storeId, { enabled: parsed.data.enabled, intervalMs: parsed.data.intervalMs })
      if (!changed) return planError('PLAN_NOT_FOUND', id)
      return ok(getPlanView(parsed.data.storeId), id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_PAUSE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanPauseSchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try {
      if (!pausePlan(parsed.data.storeId)) return planError('PLAN_NOT_FOUND', id)
      return ok(getPlanView(parsed.data.storeId), id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_RESUME, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanResumeSchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try {
      if (!resumePlan(parsed.data.storeId)) return planError('PLAN_NOT_FOUND', id)
      return ok(getPlanView(parsed.data.storeId), id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_PLAN_RUN_NOW, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsPlanRunNowSchema.safeParse(raw); if (!parsed.success) return inputError(id)
    try {
      // 立即采集走调度器队列（同一并发上限、同一运行记录），不直接调采集服务——
      // 走捷径就会出现"手动跑成功但台账里没有这一条"。
      const request = requestImmediateRun(parsed.data.storeId)
      if (!request.queued) return planError(request.reasonCode, id)
      return ok({ accepted: true, storeId: parsed.data.storeId, mode: 'SCHEDULED_IMMEDIATE', reasonCode: request.reasonCode }, id)
    } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_RUNS_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsRunsQuerySchema.safeParse(raw ?? {}); if (!parsed.success) return inputError(id)
    try { return ok(listRuns(parsed.data), id) } catch (error) { return serviceError(error, id) }
  })

  handle(IPC_CHANNELS.SALES_METRICS_HEALTH, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const id = requestId(); const parsed = salesMetricsHealthQuerySchema.safeParse(raw ?? {}); if (!parsed.success) return inputError(id)
    try { return ok(healthSnapshot(), id) } catch (error) { return serviceError(error, id) }
  })
}
