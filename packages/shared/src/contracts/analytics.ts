/**
 * 数据分析 · 经营指标聚合契约（2026-11-09）。
 *
 * 为什么要有这层：经营指标有两条历史来源——
 *   · `sales_metrics`：10 分钟自动采集写入的统一指标（有 period_type）；
 *   · `store_snapshots`：任务 readText / 手动录入写入的 `biz.*` 快照（没有周期字段）。
 * 页面上必须**优先自动采集、缺失时才回落快照**，并把来源与口径写在行上；
 * 不能让同一张表一半读 A、一半读 B，还共用一个"采集时间"。
 */

import type { SalesMetricsPeriodType } from './sales-metrics'

export const ANALYTICS_PERIOD_FILTERS = [
  'ALL',
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS'
] as const

export type AnalyticsPeriodFilter = (typeof ANALYTICS_PERIOD_FILTERS)[number]

export const ANALYTICS_PERIOD_LABELS: Readonly<Record<AnalyticsPeriodFilter, string>> = {
  ALL: '各平台最新',
  TODAY: '今日',
  YESTERDAY: '昨日',
  LAST_7_DAYS: '近 7 天',
  LAST_30_DAYS: '近 30 天'
}

export const SALES_METRICS_PERIOD_LABELS: Readonly<Record<SalesMetricsPeriodType, string>> = {
  TODAY: '今日',
  YESTERDAY: '昨日',
  LAST_7_DAYS: '近 7 天',
  LAST_30_DAYS: '近 30 天',
  CUSTOM: '自定义周期'
}

export type AnalyticsSource = 'AUTO' | 'SNAPSHOT' | 'NONE'

export const ANALYTICS_SOURCE_LABELS: Readonly<Record<AnalyticsSource, string>> = {
  AUTO: '自动采集',
  SNAPSHOT: '任务快照',
  NONE: '暂无数据'
}

export interface AnalyticsMetricRow {
  storeId: string
  storeName: string
  platform: string
  source: AnalyticsSource
  /** 自动采集行才有；任务快照没有周期字段，保持 null。 */
  periodType: SalesMetricsPeriodType | null
  periodLabel: string
  collectedAt: number | null
  dataStatus: string | null
  /** 任务快照里由用户手动录入的指标 key（`biz.*`），用于界面标「手动」。 */
  manualMetrics: string[]
  /** 键为 BIZ_METRICS.key；金额已是元（不是分），null = 该口径未提供。 */
  values: Record<string, number | null>
}

export interface AnalyticsAggregate {
  storeCount: number
  autoCount: number
  snapshotCount: number
  values: Record<string, number | null>
}

export interface AnalyticsPlatformSummary extends AnalyticsAggregate {
  platform: string
}

export interface AnalyticsSummary {
  generatedAt: number
  periodType: AnalyticsPeriodFilter
  rows: AnalyticsMetricRow[]
  byPlatform: AnalyticsPlatformSummary[]
  totals: AnalyticsAggregate
}
