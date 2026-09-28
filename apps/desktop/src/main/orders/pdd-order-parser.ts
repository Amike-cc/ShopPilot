import type {
  UnifiedOrder,
  UnifiedOrderBuyer,
  UnifiedOrderItem,
  UnifiedOrderStatus
} from '@shared/contracts/unified-order'

export interface PddOrderParserContext {
  storeId: string
  collectedAt?: number
}

export interface PddOrderParseResult {
  orders: UnifiedOrder[]
  skippedCount: number
  reasonCode: 'ORDER_PAYLOAD_PARSED' | 'ORDER_DATA_SHAPE_UNRECOGNIZED' | 'ORDER_ROWS_INVALID'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 300): string | null {
  if (value == null) return null
  const result = String(value).trim()
  return result ? result.slice(0, max) : null
}

function first(record: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (record[key] != null && record[key] !== '') return { key, value: record[key] }
  }
  return null
}

/** 纯十进制字符串转分；不使用浮点数参与金额计算。 */
export function decimalStringToMinor(value: unknown): number | null {
  const raw = text(value, 80)
  if (!raw) return null
  const normalized = raw.replace(/[￥¥\s,]/g, '')
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) return null
  try {
    const sign = match[1] === '-' ? -1n : 1n
    const integer = BigInt(match[2])
    const fraction = BigInt((match[3] || '').padEnd(2, '0') || '0')
    const minor = sign * (integer * 100n + fraction)
    const number = Number(minor)
    return Number.isSafeInteger(number) ? number : null
  } catch {
    return null
  }
}

function amount(value: unknown, key: string): number | null {
  if (value == null) return null
  if (/fen|cent|minor/i.test(key)) {
    const raw = text(value, 80)
    if (!raw || !/^-?\d+$/.test(raw)) return null
    const number = Number(raw)
    return Number.isSafeInteger(number) ? number : null
  }
  return decimalStringToMinor(value)
}

function timestamp(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000_000_000) return Math.floor(value)
    if (value > 1_000_000_000) return Math.floor(value * 1000)
  }
  const raw = text(value, 80)
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n > 10_000_000_000 ? Math.floor(n) : Math.floor(n * 1000)
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizePddOrderStatus(platformStatus: string | null): UnifiedOrderStatus {
  // 当前没有真实拼多多订单页样本核实状态文案/代码，暂不按语义猜映射。
  void platformStatus
  return 'UNKNOWN'
}

function orderArrays(payload: unknown): unknown[][] {
  if (!isRecord(payload)) return []
  const candidates: unknown[][] = []
  const add = (value: unknown): void => { if (Array.isArray(value)) candidates.push(value) }
  for (const key of ['orders', 'orderList', 'order_list', 'list', 'rows']) add(payload[key])
  for (const containerKey of ['data', 'result', 'payload']) {
    const container = payload[containerKey]
    if (!isRecord(container)) continue
    for (const key of ['orders', 'orderList', 'order_list', 'list', 'rows']) add(container[key])
  }
  return candidates
}

function itemList(record: Record<string, unknown>): unknown[] {
  for (const key of ['items', 'orderItems', 'order_items', 'goodsList', 'goods_list', 'skuList']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

function parseItem(value: unknown): UnifiedOrderItem | null {
  if (!isRecord(value)) return null
  const id = first(value, ['platformItemId', 'itemId', 'item_id', 'goodsId', 'goods_id', 'id'])
  const sku = first(value, ['platformSkuId', 'skuId', 'sku_id'])
  const title = first(value, ['title', 'name', 'goodsName', 'goods_name'])
  const skuName = first(value, ['skuName', 'sku_name', 'specification', 'spec'])
  const quantityValue = first(value, ['quantity', 'qty', 'number', 'count'])
  const quantity = quantityValue ? Number(quantityValue.value) : null
  const unit = first(value, ['unitPriceFen', 'unit_price_fen', 'unitPrice', 'unit_price', 'price'])
  const total = first(value, ['totalPriceFen', 'total_price_fen', 'totalPrice', 'total_price', 'amount'])
  const image = first(value, ['imageUrl', 'image_url', 'thumbUrl', 'thumb_url'])
  if (!id && !title) return null
  return {
    platformItemId: id ? text(id.value, 160) : null,
    platformSkuId: sku ? text(sku.value, 160) : null,
    title: title ? text(title.value) : null,
    skuName: skuName ? text(skuName.value) : null,
    quantity: quantity != null && Number.isInteger(quantity) && quantity >= 0 && quantity <= 1_000_000 ? quantity : null,
    unitPriceMinor: unit ? amount(unit.value, unit.key) : null,
    totalPriceMinor: total ? amount(total.value, total.key) : null,
    imageUrl: image ? safeImageUrl(image.value) : null
  }
}

function safeImageUrl(value: unknown): string | null {
  const raw = text(value, 1000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // 丢弃可能包含签名或临时凭据的 query/hash。
    return `${url.origin}${url.pathname}`.slice(0, 1000)
  } catch {
    return null
  }
}

function parseOrder(value: unknown, context: PddOrderParserContext): UnifiedOrder | null {
  if (!isRecord(value)) return null
  const idValue = first(value, ['platformOrderId', 'orderId', 'order_id', 'orderSn', 'order_sn', 'orderNo', 'order_no'])
  const platformOrderId = idValue ? text(idValue.value, 160) : null
  if (!platformOrderId) return null

  const statusValue = first(value, ['platformStatus', 'orderStatus', 'order_status', 'status', 'statusText'])
  const platformStatus = statusValue ? text(statusValue.value, 160) : null
  const total = first(value, ['totalAmountFen', 'total_amount_fen', 'totalAmount', 'total_amount', 'amountFen', 'amount_fen', 'amount'])
  const paid = first(value, ['paidAmountFen', 'paid_amount_fen', 'paidAmount', 'paid_amount', 'payAmount', 'pay_amount'])
  const refund = first(value, ['refundAmountFen', 'refund_amount_fen', 'refundAmount', 'refund_amount'])
  // 买家信息属于个人信息；当前最小闭环不需要它们，先不解析、不落库。
  const buyer: UnifiedOrderBuyer | null = null
  const created = first(value, ['createdAt', 'created_at', 'createTime', 'create_time', 'orderTime', 'order_time'])
  const paidAt = first(value, ['paidAt', 'paid_at', 'payTime', 'pay_time'])
  const shippedAt = first(value, ['shippedAt', 'shipped_at', 'sendTime', 'send_time'])
  const completedAt = first(value, ['completedAt', 'completed_at', 'finishTime', 'finish_time'])
  const updated = first(value, ['sourceUpdatedAt', 'source_updated_at', 'updatedAt', 'updated_at', 'updateTime', 'update_time'])
  const items = itemList(value).map(parseItem).filter((item): item is UnifiedOrderItem => !!item).slice(0, 200)
  const totalAmountMinor = total ? amount(total.value, total.key) : null
  const paidAmountMinor = paid ? amount(paid.value, paid.key) : null
  const refundAmountMinor = refund ? amount(refund.value, refund.key) : null
  const collectedAt = context.collectedAt || Date.now()
  const rawSnapshot: Record<string, unknown> = {
    platformOrderId,
    platformStatus,
    totalAmountMinor,
    paidAmountMinor,
    refundAmountMinor,
    buyer,
    items
  }
  return {
    id: '',
    platform: '拼多多',
    storeId: context.storeId,
    platformOrderId,
    status: normalizePddOrderStatus(platformStatus),
    platformStatus,
    totalAmountMinor,
    paidAmountMinor,
    refundAmountMinor,
    currency: 'CNY',
    buyer,
    items,
    createdAt: created ? timestamp(created.value) : null,
    paidAt: paidAt ? timestamp(paidAt.value) : null,
    shippedAt: shippedAt ? timestamp(shippedAt.value) : null,
    completedAt: completedAt ? timestamp(completedAt.value) : null,
    updatedAt: updated ? timestamp(updated.value) : null,
    collectedAt,
    sourceUpdatedAt: updated ? timestamp(updated.value) : null,
    rawSnapshot
  }
}

/**
 * 解析一次正常页面响应的 JSON。这里不包含 URL、接口路径、签名或 Header 猜测；
 * 只有响应本身明确提供订单列表及订单标识时才会生成 UnifiedOrder。
 */
export function parsePddOrderPayload(payload: unknown, context: PddOrderParserContext, maxOrders = 100): PddOrderParseResult {
  const arrays = orderArrays(payload)
  if (!arrays.length) return { orders: [], skippedCount: 0, reasonCode: 'ORDER_DATA_SHAPE_UNRECOGNIZED' }
  const orders: UnifiedOrder[] = []
  const seen = new Set<string>()
  let skippedCount = 0
  for (const list of arrays) {
    for (const row of list) {
      const order = parseOrder(row, context)
      if (!order) { skippedCount++; continue }
      if (seen.has(order.platformOrderId)) { skippedCount++; continue }
      seen.add(order.platformOrderId)
      orders.push(order)
      if (orders.length >= maxOrders) break
    }
    if (orders.length >= maxOrders) break
  }
  return {
    orders,
    skippedCount,
    reasonCode: orders.length ? 'ORDER_PAYLOAD_PARSED' : 'ORDER_ROWS_INVALID'
  }
}

export function parsePddJsonBody(body: string, context: PddOrderParserContext, maxOrders = 100): PddOrderParseResult {
  try {
    return parsePddOrderPayload(JSON.parse(body), context, maxOrders)
  } catch {
    return { orders: [], skippedCount: 0, reasonCode: 'ORDER_DATA_SHAPE_UNRECOGNIZED' }
  }
}
