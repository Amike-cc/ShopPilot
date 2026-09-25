import { describe, expect, it } from 'vitest'
import { ordersProfileFor, type OrdersProfile } from '@shared/constants/orders'
import { buildOrdersCollectSteps, mapOrdersRows, orderColumnLabel } from '@shared/orders-steps'

const measured: OrdersProfile = {
  platform: '测试平台',
  pageUrl: 'https://shop.example/orders',
  urlMarker: '/orders',
  periodText: '近7天',
  periodSettleMs: 3000,
  measuredAt: '2026-09-25',
  table: { selector: 'table#orders', pickByHeader: '订单号', expectHeaders: ['订单号', '订单状态'] },
  columns: [{ key: 'orderNo', header: '订单号' }, { key: 'status', header: '订单状态' }]
}

describe('Orders detail collection (measured-profile only)', () => {
  it('registers no built-in platform anchors (red line: measure before registering)', () => {
    expect(ordersProfileFor('抖店')).toBeNull()
    expect(ordersProfileFor('快手小店')).toBeNull()
    expect(ordersProfileFor('微信小店')).toBeNull()
  })

  it('accepts a measured override and rejects malformed ones', () => {
    expect(ordersProfileFor('测试平台', { 测试平台: measured })?.pageUrl).toBe(measured.pageUrl)
    expect(ordersProfileFor('测试平台', { 测试平台: { ...measured, table: { selector: '', expectHeaders: [] } } as any })).toBeNull()
    expect(ordersProfileFor('测试平台', { 测试平台: { ...measured, pageUrl: '' } as any })).toBeNull()
  })

  it('builds a read-only table sequence with period normalization and header guard', () => {
    const steps = buildOrdersCollectSteps(measured)
    expect(steps.map(step => step.type)).toEqual(['navigate', 'waitForPage', 'clickByText', 'waitMs', 'readTable'])
    const readTable = steps[4]
    expect(readTable.input).toMatchObject({ selector: 'table#orders', keepRows: true, metric: 'orders.detail', pickByHeader: '订单号', expectHeaders: ['订单号', '订单状态'] })
    // 全部是读型/无副作用步骤（可安全重试）
    expect(steps.every(step => !['setInput', 'typeText', 'click', 'clickAll', 'aiGenerate'].includes(step.type))).toBe(true)
  })

  it('waits for async data even without a period control', () => {
    const steps = buildOrdersCollectSteps({ ...measured, periodText: undefined, periodSettleMs: 4000 })
    expect(steps.map(step => step.type)).toEqual(['navigate', 'waitForPage', 'waitMs', 'readTable'])
    expect((steps[2].input as any).ms).toBe(4000)
  })

  it('maps raw rows by header text, skips the header row and keeps extras', () => {
    const mapped = mapOrdersRows(
      [{ key: 'orderNo', header: '订单号' }, { key: 'status', header: '订单状态' }],
      [['订单号', '订单状态', '备注'], ['O-1001', '已发货', '备注 A'], ['O-1002', '', ''], ['', '', '']]
    )
    expect(mapped).toHaveLength(2)
    expect(mapped[0].cells).toEqual({ orderNo: 'O-1001', status: '已发货' })
    expect(mapped[0].extras).toEqual(['备注 A'])
    expect(mapped[1].cells).toEqual({ orderNo: 'O-1002', status: '' })
    expect(orderColumnLabel('orderNo')).toBe('订单号')
    expect(mapOrdersRows([], 'not-a-table')).toEqual([])
    // 没有可识别的表头（老数据）时退回按档案列顺序映射
    expect(mapOrdersRows([{ key: 'orderNo', header: '订单号' }], [['x'], ['O-9']])[0].cells.orderNo).toBe('O-9')
  })
})
