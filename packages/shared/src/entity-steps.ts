/**
 * 店铺主体（营业执照）采集的步骤构造 —— 只读步骤，无副作用、可安全重试。
 *
 * 步骤序列：navigate(主体信息页) → waitForPage(就绪判据) → waitMs(等 SPA 取数) →
 * readLabelValue(统一社会信用代码) → readLabelValue(名称候选 1..n)
 *
 * 两个关键决定：
 *  1. **先读代码再读名称**：代码的标签文案（「统一社会信用代码」）跨主体类型不变，最稳；
 *     名称的行文案随主体类型变（个体工商户名称 / 企业名称），所以放在后面并允许"该行不存在"。
 *  2. 名称候选都带 `absentOk`：页面上没有"这一行"（企业店没有「个体工商户名称」、
 *     个人店两行都没有）不是错误——但**不会被当成读到了空值**，而是按"该行不存在"记录，
 *     由界面如实说明"没读到名称"（改版与个人店铺两种可能都明说，不编造数据）。
 *
 * 值一律 `allowText`：主体名称是公司名、信用代码是 18 位字母数字，都不是数值，
 * 不加这个开关引擎会做数值抽取（把"92411426MA9KEBPH6L"判成不是数值而失败）。
 */

import { ENTITY_METRIC_NAME, ENTITY_METRIC_NO, type EntityProfile } from './constants/entity'

export interface EntityStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export function buildEntityCollectSteps(p: EntityProfile): EntityStepDraft[] {
  const maxLen = p.maxValueLen ?? 40
  const steps: EntityStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 30000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 40000 },
    // 显式等（不是等元素）：SPA 的元素早在 DOM 里，值是后到的，等选择器会立刻命中旧/空值
    { type: 'waitMs', input: { ms: p.settleMs }, timeoutMs: p.settleMs + 10000 }
  ]

  // 统一社会信用代码：同样允许"这一行不存在"（个人店铺/未登记执照），
  // 但**不允许**读到过长的容器文本——那是页面结构变了，必须如实失败
  steps.push({
    type: 'readLabelValue',
    input: {
      label: p.noAnchor,
      metric: ENTITY_METRIC_NO,
      allowText: true,
      absentOk: true,
      maxValueLen: maxLen
    },
    timeoutMs: 20000
  })

  for (const label of p.nameAnchors) {
    steps.push({
      type: 'readLabelValue',
      input: {
        label,
        metric: ENTITY_METRIC_NAME,
        allowText: true,
        absentOk: true,
        maxValueLen: maxLen
      },
      timeoutMs: 20000
    })
  }

  return steps
}
