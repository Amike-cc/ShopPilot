/**
 * 订单域的跨进程安全契约。
 *
 * 金额统一使用人民币最小单位（分）存储，避免 JavaScript 浮点数误差。
 * 平台原始响应只在 Main 进程内解析；Renderer 只接收下面的安全订单摘要。
 */

export const UNIFIED_ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDING',
  'REFUNDED',
  'CLOSED',
  'UNKNOWN'
] as const

export type UnifiedOrderStatus = typeof UNIFIED_ORDER_STATUSES[number]

export const ORDER_DATA_SOURCES = ['NETWORK', 'DOM', 'EXPORT', 'OBSERVATION_ONLY'] as const
export type OrderDataSource = typeof ORDER_DATA_SOURCES[number]

export const ORDER_COLLECTION_STATUSES = ['SUCCEEDED', 'PARTIAL', 'OBSERVATION_ONLY', 'FAILED', 'ALREADY_RUNNING'] as const
export type OrderCollectionStatus = typeof ORDER_COLLECTION_STATUSES[number]

export interface UnifiedOrderBuyer {
  /** 仅保留平台提供的显示名/非认证标识；不保存收货地址、电话或证件信息。 */
  id: string | null
  name: string | null
}

export interface UnifiedOrderItem {
  platformItemId: string | null
  platformSkuId: string | null
  title: string | null
  skuName: string | null
  quantity: number | null
  unitPriceMinor: number | null
  totalPriceMinor: number | null
  imageUrl: string | null
}

export interface UnifiedOrder {
  id: string
  platform: string
  storeId: string
  platformOrderId: string
  status: UnifiedOrderStatus
  platformStatus: string | null
  totalAmountMinor: number | null
  paidAmountMinor: number | null
  refundAmountMinor: number | null
  currency: string
  buyer: UnifiedOrderBuyer | null
  items: UnifiedOrderItem[]
  createdAt: number | null
  paidAt: number | null
  shippedAt: number | null
  completedAt: number | null
  updatedAt: number | null
  collectedAt: number
  sourceUpdatedAt: number | null
  /** Main 内部排错快照；IPC 查询默认会移除该字段。 */
  rawSnapshot?: Record<string, unknown> | null
}

export interface SafeUnifiedOrder extends Omit<UnifiedOrder, 'rawSnapshot'> {}

export interface OrderCollectionResult {
  storeId: string
  platform: string
  status: OrderCollectionStatus
  source: OrderDataSource
  startedAt: number
  finishedAt: number
  fetchedCount: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  observedResponseCount: number
  nextCursor: string | null
  hasMore: boolean
  reasonCode: string
  safeMessage: string
}

export interface OrderListQuery {
  storeId: string
  status?: UnifiedOrderStatus
  startDate?: number
  endDate?: number
  page: number
  pageSize: number
}

export interface OrderListResult {
  storeId: string
  page: number
  pageSize: number
  total: number
  orders: SafeUnifiedOrder[]
}
