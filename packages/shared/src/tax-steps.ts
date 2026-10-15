/**
 * 「涉税信息报送」采集步骤构造。
 *
 * 与发票采集同一套路子（见 invoice-steps.ts）：navigate → waitForPage → readTable，
 * 整表读回后按**表头文案**映射到统一列。全是读取型步骤、无副作用、可安全重试。
 *
 * 与发票采集的三点不同：
 *  1. 目前每个平台只有一个方向（报送汇总表），没有页签要切 → 不需要 clickByText，
 *     也就没有"切页签失败读到上一个方向"那类风险；
 *  2. 表头与数据**分属两张 `<table>`**（实测快手）→ mergeHeaderTable，让运行器把下一张一并合并；
 *  3. **不设 measuredRows**：这张表的行数 = 该店已经过了几个报送期，随经营时长增长，
 *     拿固定条数当"抓漏"阈值会把正常的新店报成抓漏（理由见 constants/tax.ts）。
 */

import type { TaxProfile, TaxSection } from './constants/tax'

export interface TaxStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export function buildTaxCollectSteps(p: TaxProfile): TaxStepDraft[] {
  const steps: TaxStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 45000 },
    // 该页是异步取数（先出骨架再填表）；不等就直接读会读到空表
    { type: 'waitMs', input: { ms: p.settleMs || 8000 } }
  ]

  for (const sec of p.sections as TaxSection[]) {
    /**
     * 该方向读不到表格、数据只在页面自己发的接口响应里（实测微信小店：micro-app 微前端
     * 只渲染出外壳、0 个 `<table>`）→ 用 readApi 代替 readTable。
     *
     * 注意：navigate/waitMs 仍然要跑——**页面的请求是页面自己发的**，
     * readApi 只是 attach debugger 把那次响应读出来（不构造、不重放请求）。
     */
    if (sec.api) {
      steps.push({
        type: 'readApi',
        input: {
          urlMarker: sec.api.urlMarker,
          rowsPath: sec.api.rowsPath,
          fields: sec.api.fields.map(f => ({ key: f.key, path: f.path, as: f.as || 'text' })),
          metric: sec.metricKey,
          reload: sec.api.reload !== false,
          ...(sec.api.maxBytes ? { maxBytes: sec.api.maxBytes } : {}),
          // 关键列必须有值：接口没有表头文案兜底，"读到了但关键列全空"必须算失败，
          // 不能当成"这家没数据"（见 api-reader.ts 的说明）
          requireFields: sec.requireFields || [],
          ...(sec.emptyOk ? { emptyOk: true } : {})
        },
        timeoutMs: sec.api.timeoutMs || 30000
      })
      continue
    }
    steps.push({
      type: 'readTable',
      input: {
        selector: p.tableSelector,
        metric: sec.metricKey,
        keepRows: true,
        pickByHeader: sec.pickByHeader,
        // 方向校验：读到的表头必须含这些实测列名；页面改版时如实失败，
        // 而不是把"另一张表"的内容当成本表上报
        expectHeaders: Object.keys(sec.headerMap),
        ...(sec.mergeHeaderTable ? { mergeHeaderTable: true } : {}),
        // 按列序映射（columns）的方向必须钉死数据行宽度：表头文案校验挡不住
        // "平台插一列/删一列"，错位后 requireFields 可能把全部行当空 → 静默 0 条
        ...(sec.columns?.length ? { expectColumnCount: sec.columns.length } : {}),
        // 新店可能一个报送期都还没过 → 允许"表头对但没有数据行"；
        // 表本身找不到时仍会如实报错（emptyOk 不是"什么都算成功"）
        ...(sec.emptyOk ? { emptyOk: true } : {})
      },
      timeoutMs: 30000
    })
  }
  return steps
}
