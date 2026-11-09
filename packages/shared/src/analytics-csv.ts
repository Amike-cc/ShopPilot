/**
 * 数据分析 · CSV 组装（纯函数，有单测）。
 *
 * 只导出界面同一份聚合结果；不在导出时重新查库，避免出现"屏上 8 家、文件里 6 家"。
 * 空值写空单元格，写 `—` 会被 Excel 当成文本，金额列无法直接求和。
 */

import { BIZ_METRICS } from './constants/business'
import { ANALYTICS_SOURCE_LABELS, SALES_METRICS_PERIOD_LABELS, type AnalyticsSummary } from './contracts/analytics'

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function csvTime(value: number | null): string {
  if (!value) return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface AnalyticsCsvResult {
  csv: string
  rows: number
}

/** 按平台筛选后再导出：屏上选了「抖店」却导出全部平台，属于导出范围与界面不一致。 */
export function buildAnalyticsCsv(summary: AnalyticsSummary, platform?: string): AnalyticsCsvResult {
  const rows = summary.rows.filter(row => !platform || row.platform === platform)
  const header = ['店铺', '平台', '数据来源', '口径', '采集时间', ...BIZ_METRICS.map(metric => metric.label)]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push([
      row.storeName,
      row.platform,
      ANALYTICS_SOURCE_LABELS[row.source],
      row.periodType ? SALES_METRICS_PERIOD_LABELS[row.periodType] : row.periodLabel,
      csvTime(row.collectedAt),
      ...BIZ_METRICS.map(metric => csvNumber(row.values[metric.key]))
    ].map(csvCell).join(','))
  }
  return { csv: lines.join('\r\n'), rows: rows.length }
}

export { csvCell, csvNumber }
