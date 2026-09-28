import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  OrderListQuery,
  OrderListResult,
  SafeUnifiedOrder,
  UnifiedOrder,
  UnifiedOrderItem
} from '@shared/contracts/unified-order'

export interface OrderUpsertCounts {
  insertedCount: number
  updatedCount: number
  skippedCount: number
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toNullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

function mapItem(row: Record<string, unknown>): UnifiedOrderItem {
  return {
    platformItemId: toNullableString(row.platform_item_id),
    platformSkuId: toNullableString(row.platform_sku_id),
    title: toNullableString(row.title),
    skuName: toNullableString(row.sku_name),
    quantity: toNullableNumber(row.quantity),
    unitPriceMinor: toNullableNumber(row.unit_price_minor),
    totalPriceMinor: toNullableNumber(row.total_price_minor),
    imageUrl: toNullableString(row.image_url)
  }
}

function mapOrder(row: Record<string, unknown>, items: UnifiedOrderItem[]): UnifiedOrder {
  return {
    id: String(row.id),
    platform: String(row.platform),
    storeId: String(row.store_id),
    platformOrderId: String(row.platform_order_id),
    status: String(row.status) as UnifiedOrder['status'],
    platformStatus: toNullableString(row.platform_status),
    totalAmountMinor: toNullableNumber(row.total_amount_minor),
    paidAmountMinor: toNullableNumber(row.paid_amount_minor),
    refundAmountMinor: toNullableNumber(row.refund_amount_minor),
    currency: String(row.currency || 'CNY'),
    buyer: parseJson(row.buyer_json, null),
    items,
    createdAt: toNullableNumber(row.order_created_at),
    paidAt: toNullableNumber(row.paid_at),
    shippedAt: toNullableNumber(row.shipped_at),
    completedAt: toNullableNumber(row.completed_at),
    updatedAt: toNullableNumber(row.platform_updated_at),
    collectedAt: Number(row.collected_at) || 0,
    sourceUpdatedAt: toNullableNumber(row.source_updated_at),
    rawSnapshot: parseJson(row.raw_snapshot_json, null)
  }
}

export function safeOrder(order: UnifiedOrder): SafeUnifiedOrder {
  const { rawSnapshot: _rawSnapshot, ...safe } = order
  return safe
}

/** 订单 SQL 的唯一入口；Adapter/Service 不直接拼接订单 SQL。 */
export class OrderRepository {
  constructor(private readonly db: Database.Database) {}

  private transaction(fn: () => void): void {
    const candidate = this.db as unknown as { transaction?: (work: () => void) => () => void }
    if (typeof candidate.transaction === 'function') {
      candidate.transaction(fn)()
      return
    }
    // 仅供 node:sqlite 单测等兼容实现使用；better-sqlite3 走上面的原生事务 API。
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore rollback error */ }
      throw error
    }
  }

  upsertOrder(order: UnifiedOrder): { inserted: boolean; updated: boolean } {
    if (!order.platform || !order.storeId || !order.platformOrderId) {
      throw new Error('ORDER_INVALID: 订单缺少平台、店铺或平台订单号')
    }
    const existing = this.db.prepare(
      'SELECT id FROM orders WHERE platform = ? AND store_id = ? AND platform_order_id = ?'
    ).get(order.platform, order.storeId, order.platformOrderId) as { id?: string } | undefined
    const id = existing?.id || order.id || randomUUID()
    const now = Date.now()
    const buyerJson = order.buyer ? JSON.stringify(order.buyer) : null
    const rawSnapshotJson = order.rawSnapshot ? JSON.stringify(order.rawSnapshot) : null
    const write = this.db.prepare(`
      INSERT INTO orders (
        id, platform, store_id, platform_order_id, status, platform_status,
        total_amount_minor, paid_amount_minor, refund_amount_minor, currency,
        buyer_json, order_created_at, paid_at, shipped_at, completed_at,
        platform_updated_at, collected_at, source_updated_at, raw_snapshot_json, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, store_id, platform_order_id) DO UPDATE SET
        status = excluded.status,
        platform_status = excluded.platform_status,
        total_amount_minor = excluded.total_amount_minor,
        paid_amount_minor = excluded.paid_amount_minor,
        refund_amount_minor = excluded.refund_amount_minor,
        currency = excluded.currency,
        buyer_json = excluded.buyer_json,
        order_created_at = excluded.order_created_at,
        paid_at = excluded.paid_at,
        shipped_at = excluded.shipped_at,
        completed_at = excluded.completed_at,
        platform_updated_at = excluded.platform_updated_at,
        collected_at = excluded.collected_at,
        source_updated_at = excluded.source_updated_at,
        raw_snapshot_json = excluded.raw_snapshot_json,
        stored_at = excluded.stored_at
    `)
    write.run(
      id, order.platform, order.storeId, order.platformOrderId, order.status, order.platformStatus,
      order.totalAmountMinor, order.paidAmountMinor, order.refundAmountMinor, order.currency,
      buyerJson, order.createdAt, order.paidAt, order.shippedAt, order.completedAt,
      order.updatedAt, order.collectedAt || now, order.sourceUpdatedAt, rawSnapshotJson, now
    )
    const orderId = existing?.id || id
    this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId)
    const itemWrite = this.db.prepare(`
      INSERT INTO order_items (
        id, order_id, platform_item_id, platform_sku_id, title, sku_name,
        quantity, unit_price_minor, total_price_minor, image_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of order.items.slice(0, 200)) {
      itemWrite.run(
        randomUUID(), orderId, item.platformItemId, item.platformSkuId, item.title, item.skuName,
        item.quantity, item.unitPriceMinor, item.totalPriceMinor, item.imageUrl, now
      )
    }
    return { inserted: !existing, updated: !!existing }
  }

  upsertOrders(orders: readonly UnifiedOrder[]): OrderUpsertCounts {
    const unique = new Map<string, UnifiedOrder>()
    let skippedCount = 0
    for (const order of orders) {
      if (!order.platform || !order.storeId || !order.platformOrderId) { skippedCount++; continue }
      const key = `${order.platform}\u0000${order.storeId}\u0000${order.platformOrderId}`
      if (unique.has(key)) { skippedCount++; continue }
      unique.set(key, order)
    }
    let insertedCount = 0
    let updatedCount = 0
    this.transaction(() => {
      for (const order of unique.values()) {
        const result = this.upsertOrder(order)
        if (result.inserted) insertedCount++
        if (result.updated) updatedCount++
      }
    })
    return { insertedCount, updatedCount, skippedCount }
  }

  getOrderById(storeId: string, id: string): UnifiedOrder | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE store_id = ? AND id = ?').get(storeId, id) as Record<string, unknown> | undefined
    if (!row) return null
    const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid ASC').all(String(row.id)) as Array<Record<string, unknown>>
    return mapOrder(row, items.map(mapItem))
  }

  getOrderByPlatformOrderId(storeId: string, platform: string, platformOrderId: string): UnifiedOrder | null {
    const row = this.db.prepare(
      'SELECT * FROM orders WHERE store_id = ? AND platform = ? AND platform_order_id = ?'
    ).get(storeId, platform, platformOrderId) as Record<string, unknown> | undefined
    if (!row) return null
    const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid ASC').all(String(row.id)) as Array<Record<string, unknown>>
    return mapOrder(row, items.map(mapItem))
  }

  list(query: OrderListQuery): OrderListResult {
    const where = ['store_id = ?']
    const params: Array<string | number> = [query.storeId]
    if (query.status) { where.push('status = ?'); params.push(query.status) }
    if (query.startDate != null) { where.push('order_created_at >= ?'); params.push(query.startDate) }
    if (query.endDate != null) { where.push('order_created_at <= ?'); params.push(query.endDate) }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE ${whereSql}`).get(...params) as { count?: number }
    const page = Math.max(1, Math.floor(query.page))
    const pageSize = Math.max(1, Math.min(200, Math.floor(query.pageSize)))
    const offset = (page - 1) * pageSize
    const rows = this.db.prepare(`
      SELECT * FROM orders WHERE ${whereSql}
      ORDER BY COALESCE(order_created_at, stored_at) DESC, stored_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as Array<Record<string, unknown>>
    const orders = rows.map(row => {
      const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid ASC').all(String(row.id)) as Array<Record<string, unknown>>
      return safeOrder(mapOrder(row, items.map(mapItem)))
    })
    return { storeId: query.storeId, page, pageSize, total: Number(totalRow?.count || 0), orders }
  }
}
