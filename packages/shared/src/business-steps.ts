/**
 * 经营指标采集任务的步骤构造（数据中心「采集经营数据」用）。
 *
 * 序列：navigate(经营数据页) → waitForPage(就绪判据) → 每个指标一条 readLabelValue(带指标名)。
 * readLabelValue 以页面**标签文案**为锚读取该指标的值，metric 会把值写进 store_snapshots，
 * 数据中心按「店铺 × 指标」取最新一条展示。
 * 全部是读取型步骤、无副作用、可安全重试（不进 NON_RESUMABLE）。
 */

import type { BusinessProfile } from './constants/business'

export interface BizStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export function buildBusinessCollectSteps(p: BusinessProfile): BizStepDraft[] {
  const steps: BizStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 45000 }
  ]
  // 统一统计口径（实测控制项文案）：不固定周期的话各页默认周期不同，数字口径会混乱
  if (p.periodText) {
    steps.push({
      type: 'clickByText',
      input: { text: p.periodText, ...(p.periodDeep ? { deep: true, mode: 'real' } : {}) },
      timeoutMs: 20000
    })
    // 点完周期页面要重新取数：数值原地刷新，读取步骤会立刻命中旧值（实测快手踩过），
    // 因此显式等页面刷完再读
    steps.push({ type: 'waitMs', input: { ms: p.periodSettleMs || 6000 } })
  }
  for (const m of p.metrics) {
    steps.push({
      type: 'readLabelValue',
      input: {
        label: m.anchorText,
        metric: m.key,
        ...(m.deep ? { deep: true } : {}),
        ...(m.valueMaxLen ? { maxValueLen: m.valueMaxLen } : {})
      },
      timeoutMs: 25000
    })
  }
  return steps
}
