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
import { ORDER_COLUMNS } from './constants/orders'

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

/** 明细统一列的标签（界面表头用）。 */
export function orderColumnLabel(key: string): string {
  return ORDER_COLUMNS.find(column => column.key === key)?.label || key
}

/**
 * 把原始表行映射到统一列。
 *
 * 约定与发票中心一致：**第 0 行是表头**（readTable keepRows 落下的原始行含表头），
 * 按**表头文案**匹配档案的 `columns[].header` → 统一列 key，表头行本身不产出数据行；
 * 表头匹配不到任何列（老数据/空表头）时退回按档案列顺序映射。
 * 多出来的列不丢：按表头文案收进 extras。纯函数，Main 汇总与导出共用。
 */
export function mapOrdersRows(
  columns: Array<{ key: string; header: string }>,
  rows: unknown
): Array<{ cells: Record<string, string>; extras: string[] }> {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return []
  const headerRow = Array.isArray(list[0]) ? list[0].map(cell => String(cell ?? '').trim()) : []
  const headerMap = new Map(columns.map(column => [column.header.trim(), column.key]))
  const colOf = new Map<number, string>()
  const extraIdx: number[] = []
  headerRow.forEach((text, index) => {
    const key = headerMap.get(text)
    if (key) colOf.set(index, key)
    else if (text) extraIdx.push(index)
  })
  if (!colOf.size) columns.forEach((column, index) => colOf.set(index, column.key))
  const emptyCells = (): Record<string, string> => Object.fromEntries(columns.map(column => [column.key, '']))
  return list.slice(1)
    .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
    .slice(0, 500)
    .map(row => {
      const values = row as unknown[]
      const cells = emptyCells()
      for (const [index, key] of colOf) cells[key] = String(values[index] ?? '').slice(0, 300)
      const extras = extraIdx.map(index => String(values[index] ?? '').slice(0, 300)).filter(Boolean)
      return { cells, extras }
    })
}
