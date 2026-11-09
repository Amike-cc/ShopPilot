import { describe, expect, it } from 'vitest'
import { buildAnalyticsCsv } from '@shared/analytics-csv'
import type { AnalyticsSummary } from '@shared/contracts/analytics'

function summary(overrides: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    generatedAt: 1,
    periodType: 'ALL',
    totals: { storeCount: 2, autoCount: 1, snapshotCount: 1, values: {} },
    byPlatform: [],
    rows: [
      {
        storeId: 's1', storeName: '甲店', platform: '抖店', source: 'AUTO',
        periodType: 'TODAY', periodLabel: '今日', collectedAt: Date.UTC(2026, 10, 9, 3, 30),
        dataStatus: 'REAL_VALUE', manualMetrics: [],
        values: { 'biz.units': 3, 'biz.orders': 2, 'biz.gmv': 1234.5, 'biz.refundAmount': null, 'biz.refundOrders': 0, 'biz.adSpend': 12.3 }
      },
      {
        storeId: 's2', storeName: '乙店, "旗舰"', platform: '快手小店', source: 'SNAPSHOT',
        periodType: null, periodLabel: '任务快照', collectedAt: Date.UTC(2026, 10, 8, 3, 30),
        dataStatus: null, manualMetrics: ['biz.gmv'],
        values: { 'biz.units': null, 'biz.orders': null, 'biz.gmv': 88, 'biz.refundAmount': null, 'biz.refundOrders': null, 'biz.adSpend': null }
      }
    ],
    ...overrides
  }
}

describe('数据分析经营指标 CSV', () => {
  it('表头含来源与口径，六个指标按固定顺序导出', () => {
    const { csv, rows } = buildAnalyticsCsv(summary())
    const header = csv.split('\r\n')[0]
    expect(rows).toBe(2)
    expect(header).toBe('店铺,平台,数据来源,口径,采集时间,销量,订单,销售额,退款金额,退款订单数,投放花费')
  })

  it('自动采集行写平台周期，任务快照行写「任务快照」', () => {
    const lines = buildAnalyticsCsv(summary()).csv.split('\r\n')
    expect(lines[1]).toContain('自动采集,今日')
    expect(lines[2]).toContain('任务快照,任务快照')
  })

  it('空值写空单元格，0 保留为 0（0 是真实值，不是缺失）', () => {
    const lines = buildAnalyticsCsv(summary()).csv.split('\r\n')
    const auto = lines[1].split(',')
    // 店铺,平台,来源,口径,时间,销量,订单,销售额,退款金额,退款订单数,投放花费
    expect(auto[5]).toBe('3')
    expect(auto[8]).toBe('')
    expect(auto[9]).toBe('0')
  })

  it('按平台筛选后只导出该平台，且门店名里的逗号/引号转义', () => {
    const filtered = buildAnalyticsCsv(summary(), '快手小店')
    expect(filtered.rows).toBe(1)
    expect(filtered.csv).toContain('"乙店, ""旗舰"""')
    expect(filtered.csv).not.toContain('甲店')
  })
})
