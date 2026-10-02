import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { migrate } from '../../apps/desktop/src/main/db/migrations'
import { OrderRepository } from '../../apps/desktop/src/main/orders/order-repository'
import { orderLifecycleServiceFor } from '../../apps/desktop/src/main/orders/order-lifecycle-service'
import type { UnifiedOrder } from '@shared/contracts/unified-order'

type Db = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
  close(): void
}
type Ctor = new (path: string) => Db

function dbCtor(): Ctor | null {
  try { return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: Ctor }).DatabaseSync ?? null } catch { return null }
}

const Ctor = dbCtor()
const realIt = Ctor ? it : it.skip

function setup(): Db {
  const db = new Ctor!(':memory:')
  const shim = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
    transaction: (fn: () => void) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error } }
  }
  migrate(shim as never)
  db.prepare(`INSERT INTO stores (id,name,platform,admin_url,status,avatar_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run('store_1', '测试店', '拼多多', 'https://example.invalid', 'online', '#000', 0, 0)
  const order: UnifiedOrder = {
    id: 'order_1', platform: '拼多多', storeId: 'store_1', platformOrderId: 'PDD-1', status: 'PAID', platformStatus: '待发货',
    totalAmountMinor: 1000, paidAmountMinor: 1000, refundAmountMinor: null, currency: 'CNY', buyer: null, items: [],
    createdAt: 100, paidAt: 110, shippedAt: null, completedAt: null, updatedAt: 120, collectedAt: 130, sourceUpdatedAt: 120,
    rawSnapshot: { buyer: { name: 'private' }, address: 'private' }
  }
  new OrderRepository(db as never).upsertOrder(order)
  return db
}

describe('订单履约、售后和退款领域服务', () => {
  realIt('为已付款订单创建幂等发货提案，确认后保持未验证且不产生页面副作用', () => {
    const db = setup()
    const service = orderLifecycleServiceFor(db as never)
    expect(service.prepareFulfillment('store_1', ['order_1']).status).toBe('WAITING_CONFIRMATION')
    expect(service.prepareFulfillment('store_1', ['order_1']).summary.prepared).toBe(1)
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM order_action_proposals').get() as { c: number }).c)).toBe(1)
    const confirmed = service.confirmFulfillment('store_1', 'order_1', true, 'confirm_1')
    expect(confirmed.status).toBe('NOT_VERIFIED')
    expect(confirmed.reasonCode).toBe('FULFILLMENT_PLATFORM_NOT_VERIFIED')
    expect((db.prepare('SELECT side_effect_started, confirmation_id FROM order_action_proposals').get() as { side_effect_started: number; confirmation_id: string }).side_effect_started).toBe(0)
    db.close()
  })

  realIt('校验退款金额、创建人工提案并拒绝超额退款；隐私不进入提案 JSON', () => {
    const db = setup()
    const service = orderLifecycleServiceFor(db as never)
    const waiting = service.confirmRefund({ storeId: 'store_1', orderId: 'order_1', amountMinor: 500, confirmed: false })
    expect(waiting.status).toBe('WAITING_CONFIRMATION')
    expect(waiting.reasonCode).toBe('CONFIRMATION_REQUIRED')
    const duplicate = service.confirmRefund({ storeId: 'store_1', orderId: 'order_1', amountMinor: 500, confirmed: true, confirmationId: 'confirm_refund' })
    expect(duplicate.status).toBe('NOT_VERIFIED')
    expect(Number((db.prepare('SELECT COUNT(*) AS c FROM order_action_proposals').get() as { c: number }).c)).toBe(1)
    const raw = String((db.prepare('SELECT before_after_json FROM order_action_proposals').get() as { before_after_json: string }).before_after_json)
    expect(raw).not.toContain('private')
    expect(service.confirmRefund({ storeId: 'store_1', orderId: 'order_1', amountMinor: 1001, confirmed: false }).reasonCode).toBe('REFUND_EXCEEDS_PAID_AMOUNT')
    expect(service.verifyRefund('store_1', 'order_1').status).toBe('UNKNOWN')
    expect(service.verifyRefund('store_1', 'order_1').summary.refundStatus).toBe('UNKNOWN')
    db.close()
  })
})
