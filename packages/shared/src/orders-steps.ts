/**
 * 「订单明细」采集步骤构造（逐条订单列表）。
 *
 * 序列：navigate(订单页) → waitForPage(就绪判据) →（可选）统一周期 → readTable(keepRows)。
 * 全部是读取型步骤、无副作用、可安全重试。
 *
 * 为什么整表读：订单明细字段多、平台列名/列数经常变，逐字段 readText 会写死大量锚点；
 * 整表读回（keepRows）后按表头文案映射到 ORDER_COLUMNS，平台加列也不会崩。
 * expectHeaders 是**方向校验**：页面改版或读到别的表时如实失败，而不是错报数据。
 */

import type { OrdersProfile } from './constants/orders'

export interface OrdersStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export function buildOrdersCollectSteps(p: OrdersProfile): OrdersStepDraft[] {
  const steps: OrdersStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 45000 }
  ]
  if (p.periodText) {
    steps.push({
      type: 'clickByText',
      input: { text: p.periodText, ...(p.periodDeep ? { deep: true, mode: 'real' } : {}) },
      timeoutMs: 20000
    })
    steps.push({ type: 'waitMs', input: { ms: p.periodSettleMs || 6000 } })
  } else {
    // 不切周期也要等异步取数完成，否则读到空表
    steps.push({ type: 'waitMs', input: { ms: p.periodSettleMs || 6000 } })
  }
  steps.push({
    type: 'readTable',
    input: {
      selector: p.table.selector,
      metric: 'orders.detail',
      keepRows: true,
      ...(p.table.pickByHeader ? { pickByHeader: p.table.pickByHeader } : {}),
      ...(p.table.expectHeaders.length ? { expectHeaders: p.table.expectHeaders } : {}),
      ...(p.table.deep ? { deep: true } : {})
    },
    timeoutMs: 45000
  })
  return steps
}
