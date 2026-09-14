/**
 * 发票中心「抓取待开票信息」的步骤构造。
 *
 * 与经营指标采集（business-steps.ts）同一套路：navigate → waitForPage →（可选）点页签 →
 * readTable(keepRows) 把整表行数组落快照。全部是读取型步骤、无副作用、可安全重试。
 *
 * 为什么用 readTable 而不是逐字段 readText：
 * 发票是"一行一张单"的表格，列数各平台不同（拼多多 15 列、抖店 4 列），
 * 逐列读会写死大量锚点；整表读回后再按表头文案映射到统一列，平台加列也不会崩。
 */

import type { InvoiceProfile } from './constants/invoice'

export interface InvoiceStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export function buildInvoiceCollectSteps(p: InvoiceProfile): InvoiceStepDraft[] {
  const steps: InvoiceStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 45000 }
  ]
  // 默认页签未必是"待开票"（微信默认在「可开票」页签，但抖店默认在"我给平台开票"）
  if (p.tabText) {
    steps.push({
      type: 'clickByText',
      input: { text: p.tabText, deep: !!p.deep, mode: 'real' },
      timeoutMs: 20000
    })
  }
  // 读表前等异步取数完成（发票页普遍是进页面后才拉数据）
  steps.push({ type: 'waitMs', input: { ms: p.settleMs || 6000 } })
  steps.push({
    type: 'readTable',
    input: {
      selector: p.tableSelector,
      metric: p.metric,
      keepRows: true,
      // 页面上可能有多张表（微信发票中心有 2 张日历表）→ 按表头文案挑出数据表
      pickByHeader: p.pickByHeader,
      // 表头与数据分属两个 <table> 时（实测拼多多）把下一张表一并读进来
      ...(p.mergeHeaderTable ? { mergeHeaderTable: true } : {}),
      ...(p.deep ? { deep: true } : {})
    },
    timeoutMs: 30000
  })
  return steps
}
