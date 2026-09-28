/** 统一订单 IPC：Renderer 只能传店铺 ID 与有限分页参数。 */

import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import {
  orderCollectInputSchema,
  orderIdInputSchema,
  orderListQuerySchema,
  pddOrderObservationStartSchema,
  pddOrderObservationStopSchema
} from '@shared/schemas/order'
import { orderCollectionService } from '../orders/order-collection-service'
import { pddOrderObservationService } from '../orders/pdd-order-observation-service'

function requestId(): string { return randomUUID() }
function ok<T>(data: T, requestIdValue: string): IPCResult<T> { return { ok: true, data, requestId: requestIdValue } }
function fail(code: string, message: string, requestIdValue: string): IPCResult {
  return { ok: false, error: { code, message: message.slice(0, 300) }, requestId: requestIdValue }
}

function inputError(requestIdValue: string): IPCResult {
  return fail('INVALID_ARGUMENT', '订单请求参数不合法', requestIdValue)
}

function serviceError(error: unknown, requestIdValue: string): IPCResult {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'STORE_NOT_FOUND') return fail('STORE_NOT_FOUND', '店铺不存在或已删除', requestIdValue)
  if (code === 'APP_LOCKED') return fail('APP_LOCKED', '应用已锁定', requestIdValue)
  if (code === 'INVALID_ARGUMENT') return fail('INVALID_ARGUMENT', '订单请求参数不合法', requestIdValue)
  return fail('INTERNAL_ERROR', '订单操作失败', requestIdValue)
}

const handle = familyHandle('订单')

export function registerOrderHandlers(): void {
  handle(IPC_CHANNELS.ORDER_COLLECT, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = orderCollectInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(await orderCollectionService.collect(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.ORDER_LIST, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = orderListQuerySchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(orderCollectionService.list(parsed.data), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.ORDER_GET, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = orderIdInputSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try { return ok(orderCollectionService.get(parsed.data.storeId, parsed.data.orderId), rid) } catch (error) { return serviceError(error, rid) }
  })

  handle(IPC_CHANNELS.ORDER_OBSERVATION_START, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = pddOrderObservationStartSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      return ok(await pddOrderObservationService.start(parsed.data.storeId, parsed.data), rid)
    } catch (error) {
      return serviceError(error, rid)
    }
  })

  handle(IPC_CHANNELS.ORDER_OBSERVATION_STOP, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const rid = requestId()
    const parsed = pddOrderObservationStopSchema.safeParse(raw)
    if (!parsed.success) return inputError(rid)
    try {
      return ok(await pddOrderObservationService.stop(parsed.data.storeId), rid)
    } catch (error) {
      return serviceError(error, rid)
    }
  })
}
